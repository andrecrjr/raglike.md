import * as fs from "node:fs";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { Content } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { toString as mdastToString } from "mdast-util-to-string";
import pdf2md from "pdf2md-ts";
import { logger } from "./logger";

export interface Section {
	breadcrumbs: string[];
	nodes: Content[];
}

export class Chunker {
	async convertPdfToMarkdown(filePath: string): Promise<string> {
		logger.info({ file: filePath }, "Converting PDF to markdown...");
		const pdfBuffer = fs.readFileSync(filePath);
		const pdfData = await pdf2md(pdfBuffer);
		const content = Array.isArray(pdfData) ? pdfData.join("\n") : pdfData;
		logger.info(
			{ file: filePath, contentLength: content.length },
			"PDF conversion successful.",
		);
		return content;
	}

	detectLanguage(text: string, supportedLanguages: string[]): string {
		const normalized = text.toLowerCase();

		const stopWords: Record<string, string[]> = {
			english: [
				"the",
				"and",
				"of",
				"to",
				"in",
				"is",
				"that",
				"it",
				"for",
				"on",
				"with",
				"as",
			],
			portuguese: [
				"o",
				"a",
				"os",
				"as",
				"de",
				"do",
				"da",
				"em",
				"um",
				"uma",
				"para",
				"com",
				"por",
				"que",
				"se",
			],
			spanish: [
				"el",
				"la",
				"los",
				"las",
				"de",
				"del",
				"en",
				"un",
				"una",
				"para",
				"con",
				"por",
				"que",
				"como",
			],
			french: [
				"le",
				"la",
				"les",
				"de",
				"des",
				"en",
				"un",
				"une",
				"pour",
				"avec",
				"par",
				"que",
				"dans",
			],
			german: [
				"der",
				"die",
				"das",
				"und",
				"ist",
				"in",
				"zu",
				"den",
				"von",
				"mit",
				"auf",
				"für",
			],
		};

		let bestLang = "english";
		let maxCount = 0;

		for (const lang of supportedLanguages) {
			const words = stopWords[lang];
			if (!words) continue;

			let count = 0;
			for (const word of words) {
				const regex = new RegExp(`\\b${word}\\b`, "g");
				const matches = normalized.match(regex);
				if (matches) {
					count += matches.length;
				}
			}

			if (count > maxCount) {
				maxCount = count;
				bestLang = lang;
			}
		}

		return bestLang;
	}

	structuralSplit(content: string): Section[] {
		const tree = fromMarkdown(content);
		const sections: Section[] = [];

		const processNodes = (nodes: Content[], breadcrumbs: string[]) => {
			let currentSectionContent: Content[] = [];

			for (const node of nodes) {
				if (node.type === "heading") {
					if (currentSectionContent.length > 0) {
						sections.push({
							breadcrumbs: [...breadcrumbs],
							nodes: currentSectionContent,
						});
						currentSectionContent = [];
					}
					const level = node.depth;
					const headingText = mdastToString(node);
					breadcrumbs = breadcrumbs.slice(0, level - 1);
					breadcrumbs[level - 1] = headingText;
				} else {
					currentSectionContent.push(node);
				}
			}

			if (currentSectionContent.length > 0) {
				sections.push({
					breadcrumbs: [...breadcrumbs],
					nodes: currentSectionContent,
				});
			}
		};

		processNodes(tree.children, []);
		return sections;
	}

	async semanticSubSplit(
		nodes: Content[],
		getVectors: (blocks: string[]) => Promise<Float32Array[]>,
	): Promise<string[]> {
		const blocks = nodes
			.map((node) => toMarkdown({ type: "root", children: [node] }).trim())
			.filter((b) => b.length > 0);

		if (blocks.length <= 1) {
			return [toMarkdown({ type: "root", children: nodes }).trim()];
		}

		let vectors: Float32Array[];
		try {
			vectors = await getVectors(blocks);
		} catch (_e) {
			return [toMarkdown({ type: "root", children: nodes }).trim()];
		}

		const chunks: string[] = [];
		let currentChunkBlocks: string[] = [blocks[0]];

		for (let i = 0; i < vectors.length - 1; i++) {
			const similarity = this.cosineSimilarity(vectors[i], vectors[i + 1]);
			const nextIsCode = blocks[i + 1].trim().startsWith("```");

			if (
				!nextIsCode &&
				similarity < 0.35 &&
				currentChunkBlocks.join("\n\n").length > 200
			) {
				chunks.push(currentChunkBlocks.join("\n\n"));
				currentChunkBlocks = [blocks[i + 1]];
			} else {
				currentChunkBlocks.push(blocks[i + 1]);
			}
		}
		chunks.push(currentChunkBlocks.join("\n\n"));

		const finalChunks: string[] = [];
		for (const chunk of chunks) {
			const hasCode = chunk.includes("```");
			if (chunk.length > 1200 && !hasCode) {
				const recursiveSplitter = new RecursiveCharacterTextSplitter({
					chunkSize: 1000,
					chunkOverlap: 250,
				});
				const subParts = await recursiveSplitter.splitText(chunk);
				finalChunks.push(...subParts);
			} else {
				finalChunks.push(chunk);
			}
		}

		return finalChunks;
	}

	getFirstSentence(text: string): string {
		const cleaned = text.replace(/#+\s+.*?\n/g, "").trim();
		const match = cleaned.match(/^.*?[.!?](?:\s+|$)/s);
		return match ? match[0].trim() : cleaned.slice(0, 100);
	}

	getLastSentence(text: string): string {
		const cleaned = text.trim();
		const match = cleaned.match(/(?:^|[\n.!?])\s*([^.!?\n]+[.!?])\s*$/s);
		return match ? match[1].trim() : cleaned.slice(-100);
	}

	private cosineSimilarity(v1: Float32Array, v2: Float32Array): number {
		let dot = 0;
		for (let i = 0; i < v1.length; i++) {
			dot += v1[i] * v2[i];
		}
		return dot;
	}
}
