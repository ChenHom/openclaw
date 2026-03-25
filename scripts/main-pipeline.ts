import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  splitIntoParagraphs,
  maskBatchParagraphs,
  translateBatch,
  unmaskBatchContent,
  validateParagraphIntegrity,
} from "./engine-core";
import { loadProgress, saveProgress, getPendingFiles } from "./file-io";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROGRESS_FILE = ".docs-sync-progress.json";
const API_KEY = process.env.OPENAI_API_KEY!;
const PROMPT_FILE = path.join(__dirname, "references", "translation-prompt.md");
const DICT_PATH = path.join(__dirname, "zh-TW-linter.json");

interface Rule {
  pattern: string;
  replacement: string;
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: "", body: content };
  }
  return { frontmatter: match[0], body: content.slice(match[0].length) };
}

async function applyLocalization(content: string): Promise<string> {
  try {
    const dictRaw = await fs.readFile(DICT_PATH, "utf-8");
    const dict = JSON.parse(dictRaw) as { rules: Rule[] };
    let processed = content;
    for (const rule of dict.rules) {
      const regex = new RegExp(rule.pattern, "g");
      processed = processed.replace(regex, rule.replacement);
    }
    return processed;
  } catch {
    return content;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const outputDir = args.find((a) => a.startsWith("--output="))?.split("=")[1];
  const inputDir = args.find((a) => a.startsWith("--input="))?.split("=")[1] || "docs";
  const isForce = args.includes("--force");
  const model = args.find((a) => a.startsWith("--model="))?.split("=")[1] || "gpt-4.1-mini";

  let batchSize = parseInt(args.find((a) => a.startsWith("--batch-size="))?.split("=")[1] || "10");

  if (!args.some((a) => a.startsWith("--batch-size="))) {
    if (model.includes("mini")) {
      batchSize = 15;
    } else if (model.includes("gpt-4o") || model.includes("gpt-5")) {
      batchSize = 5;
    }
  }

  if (!outputDir || !API_KEY) {
    console.error("❌ 錯誤：缺少必要參數或 OPENAI_API_KEY。");
    process.exit(1);
  }

  const rawPrompt = await fs.readFile(PROMPT_FILE, "utf-8");
  const systemPrompt = `${rawPrompt}\n7. 內容包含多個段落，以 ---BATCH_SEP--- 分隔。請精確保留該分隔符。`;

  const completed = await loadProgress(PROGRESS_FILE);
  const files = await getPendingFiles({ docsDir: inputDir, isForce, completedFiles: completed });

  console.log(`🚀 啟動翻譯管線: [${model}] (Batch: ${batchSize}) ${inputDir} -> ${outputDir}`);

  for (const file of files) {
    console.log(`========================================\n[處理中] ${file}`);
    const sourcePath = path.join(process.cwd(), file);
    const targetPath = path.join(process.cwd(), outputDir, path.relative(inputDir, file));

    try {
      const sourceRaw = await fs.readFile(sourcePath, "utf-8");
      const { frontmatter } = splitFrontmatter(sourceRaw);
      const paragraphs = splitIntoParagraphs(sourceRaw);
      const translatedParagraphs: string[] = [];

      for (let i = 0; i < paragraphs.length; i += batchSize) {
        const currentBatch = paragraphs.slice(i, i + batchSize);
        process.stdout.write(`  -> 段落 ${i + 1} ~ ${Math.min(i + batchSize, paragraphs.length)}: `);

        const { maskedBatch, blocksMap } = maskBatchParagraphs(currentBatch);
        let batchSuccess = false;
        let batchResults: string[] = [];

        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const translatedBatch = await translateBatch(API_KEY, systemPrompt, maskedBatch, model);
            batchResults = unmaskBatchContent(translatedBatch, blocksMap);

            if (batchResults.length === currentBatch.length) {
              let allValid = true;
              for (let j = 0; j < currentBatch.length; j++) {
                if (!validateParagraphIntegrity(currentBatch[j], batchResults[j])) {
                  allValid = false;
                  break;
                }
              }
              if (allValid) {
                batchSuccess = true;
                break;
              }
            }
          } catch {}
          process.stdout.write(`(B-R${attempt + 1}) `);
        }

        if (batchSuccess) {
          translatedParagraphs.push(...batchResults);
          process.stdout.write(`✅\n`);
        } else {
          process.stdout.write(`⚠️ [降級] 批次失敗，切換為逐段模式...\n`);
          for (let k = 0; k < currentBatch.length; k++) {
            const p = currentBatch[k];
            process.stdout.write(`     └─> 處理子段落 ${i + k + 1}... `);
            const { maskedBatch: m, blocksMap: bm } = maskBatchParagraphs([p]);
            let pSuccess = false;
            let pResult = "";
            for (let pAttempt = 0; pAttempt < 5; pAttempt++) {
              try {
                const tr = await translateBatch(API_KEY, systemPrompt, m, model);
                pResult = unmaskBatchContent(tr, bm)[0];
                if (validateParagraphIntegrity(p, pResult)) {
                  pSuccess = true;
                  break;
                }
              } catch {}
              process.stdout.write(`(P-R${pAttempt + 1}) `);
            }
            if (!pSuccess) {
              console.error(`\n❌ [致命錯誤] 檔案 ${file} 段落 ${i + k + 1} 無法修復。`);
              process.exit(1);
            }
            translatedParagraphs.push(pResult);
            process.stdout.write(`✅\n`);
          }
        }
      }

      const finalBody = await applyLocalization(translatedParagraphs.join("\n\n"));
      const finalDoc = frontmatter ? `${frontmatter}${finalBody}\n` : `${finalBody}\n`;
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, finalDoc, "utf-8");
      await saveProgress(PROGRESS_FILE, file);
      console.log(`✅ [完成] ${file} 翻譯成功！`);
    } catch (err: unknown) {
      const error = err as Error;
      console.error(`❌ [異常] ${file}: ${error.message}`);
      process.exit(1);
    }
  }

  console.log(`\n🎉 所有翻譯任務完成！`);
  await fs.rm(PROGRESS_FILE, { force: true }).catch(() => {});
}

main().catch(console.error);
