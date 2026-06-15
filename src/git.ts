import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { VectorEngine } from "./engine";
import { logger } from "./logger";

export class GitManager {
	private engine: VectorEngine;
	private baseDir: string;

	constructor(engine: VectorEngine) {
		this.engine = engine;
		this.baseDir = path.join(process.cwd(), ".repos");
		if (!fs.existsSync(this.baseDir)) {
			fs.mkdirSync(this.baseDir, { recursive: true });
		}
	}

	private runCommand(
		command: string,
		args: string[],
		cwd: string,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const process = spawn(command, args, { cwd });

			process.on("close", (code) => {
				if (code === 0) resolve();
				else
					reject(
						new Error(
							`Command ${command} ${args.join(" ")} failed with code ${code}`,
						),
					);
			});

			process.on("error", (err) => reject(err));
		});
	}

	async syncRepository(repoUrl: string, repositoryId: string) {
		const repoDir = path.join(this.baseDir, repositoryId);
		const isNew = !fs.existsSync(repoDir);

		try {
			if (isNew) {
				logger.info({ repoUrl, repositoryId }, "Cloning new repository...");
				await this.runCommand(
					"git",
					["clone", repoUrl, repositoryId],
					this.baseDir,
				);
			} else {
				logger.info(
					{ repositoryId },
					"Pulling latest changes for repository...",
				);
				await this.runCommand("git", ["pull"], repoDir);
			}

			// After sync, re-index the directory
			await this.indexRepoDirectory(repoDir, repositoryId);
			logger.info({ repositoryId }, "Repository sync and indexing complete.");
		} catch (err) {
			logger.error({ err, repositoryId }, "Failed to sync repository");
			throw err;
		}
	}

	private async indexRepoDirectory(dir: string, repositoryId: string) {
		const files = this.getFilesRecursively(dir);
		for (const file of files) {
			await this.engine.indexSingleFile(file, repositoryId);
		}
	}

	private getFilesRecursively(dir: string): string[] {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		const files = entries.map((entry) => {
			const res = path.resolve(dir, entry.name);
			return entry.isDirectory() ? this.getFilesRecursively(res) : res;
		});
		return files.flat().filter((f) => f.endsWith(".md"));
	}
}
