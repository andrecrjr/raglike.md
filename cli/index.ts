#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";

export interface FileInfo {
	path: string;
	name: string;
	size: number;
}

interface ServerDoc {
	name: string;
	size: number;
}

export async function discoverFiles(
	dir: string,
	baseDir: string = dir,
): Promise<FileInfo[]> {
	const files: FileInfo[] = [];
	const entries = fs.readdirSync(dir);

	for (const entry of entries) {
		const fullPath = path.join(dir, entry);
		const stats = fs.statSync(fullPath);

		if (stats.isDirectory()) {
			files.push(...(await discoverFiles(fullPath, baseDir)));
		} else if (
			stats.isFile() &&
			(entry.endsWith(".md") || entry.endsWith(".pdf"))
		) {
			files.push({
				path: fullPath,
				name: entry,
				size: stats.size,
			});
		}
	}

	return files;
}

export async function compareAndUpload(
	serverUrl: string,
	token: string | undefined,
	localFiles: FileInfo[],
): Promise<{ uploaded: string[]; skipped: string[]; failed: string[] }> {
	const headers: Record<string, string> = {};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	// 1. Get server state
	const listRes = await fetch(`${serverUrl}/list-docs`, { headers });
	if (!listRes.ok) {
		throw new Error(`Failed to list docs: ${listRes.statusText}`);
	}
	const { docs: serverDocs } = (await listRes.json()) as { docs: ServerDoc[] };

	const uploaded: string[] = [];
	const skipped: string[] = [];
	const failed: string[] = [];

	// 2. Compare and Upload
	for (const local of localFiles) {
		const serverMatch = serverDocs.find(
			(s) => s.name === local.name && s.size === local.size,
		);

		if (serverMatch) {
			skipped.push(local.name);
			continue;
		}

		// Need to upload
		try {
			const formData = new FormData();
			const fileBlob = new Blob([fs.readFileSync(local.path)]);
			formData.append("file", fileBlob, local.name);

			const uploadRes = await fetch(`${serverUrl}/upload`, {
				method: "POST",
				headers,
				body: formData,
			});

			if (uploadRes.ok) {
				uploaded.push(local.name);
			} else {
				failed.push(local.name);
			}
		} catch (err) {
			console.error(`Error uploading ${local.name}:`, err);
			failed.push(local.name);
		}
	}

	return { uploaded, skipped, failed };
}

if (import.meta.main) {
	const { parseArgs } = await import("node:util");

	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			server: { type: "string", short: "s" },
			token: { type: "string", short: "t" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: true,
	});

	if (values.help || positionals.length === 0) {
		console.log(`
raglike-cli - Sync local Markdown files to raglike-md

Usage:
  raglike-cli <directory> [options]

Options:
  -s, --server <url>   Server URL
  -t, --token <token>  API Bearer token
  -h, --help           Show this help message

Configuration:
  You can create a .raglike file (JSON) in your current directory or home folder:
  {
    "server": "http://localhost:4321",
    "token": "your-secret-token"
  }
`);
		process.exit(0);
	}

	// 1. Load config
	let config: { server?: string; token?: string } = {};
	const localConfigPath = path.join(process.cwd(), ".raglike");
	const homeConfigPath = path.join(
		process.env.HOME || process.env.USERPROFILE || "",
		".raglike",
	);

	let configFound = false;
	if (fs.existsSync(localConfigPath)) {
		config = JSON.parse(fs.readFileSync(localConfigPath, "utf-8"));
		configFound = true;
	} else if (fs.existsSync(homeConfigPath)) {
		config = JSON.parse(fs.readFileSync(homeConfigPath, "utf-8"));
		configFound = true;
	}

	// 2. Validation: If no config file, must provide flags
	if (!configFound && !values.server && !values.token) {
		console.error(
			"Error: No configuration found (.raglike) and no --server or --token flags provided.",
		);
		console.log("Please create a .raglike file or use the flags.");
		process.exit(1);
	}

	const serverUrl = values.server || config.server || "http://localhost:4321";
	const token = values.token || config.token;

	const targetDir = path.resolve(positionals[0]);
	if (!fs.existsSync(targetDir)) {
		console.error(`Error: Directory not found: ${targetDir}`);
		process.exit(1);
	}

	console.log(`🔍 Scanning ${targetDir}...`);
	const localFiles = await discoverFiles(targetDir);
	console.log(`Found ${localFiles.length} documents.`);

	try {
		const { uploaded, skipped, failed } = await compareAndUpload(
			serverUrl as string,
			token,
			localFiles,
		);

		console.log("\nSync Complete:");
		console.log(`✅ Uploaded: ${uploaded.length}`);
		console.log(`⏭️  Skipped:  ${skipped.length}`);
		if (failed.length > 0) {
			console.log(`❌ Failed:   ${failed.length}`);
			for (const f of failed) {
				console.log(`   - ${f}`);
			}
		}
	} catch (err) {
		console.error(
			"Fatal Error during sync:",
			err instanceof Error ? err.message : err,
		);
		process.exit(1);
	}
}
