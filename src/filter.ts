// src/filter.ts
import { join } from "node:path";
import { createPersistentDedupe } from "openclaw/plugin-sdk";
import type { JobItem, Filters } from "./types.js";
import { getStateDir } from "./storage.js";

// 解析薪资描述，返回 [min, max] 千元，无法解析返回 null
function parseSalaryK(salaryDesc: string): [number, number] | null {
  // 匹配 "15-25K" 或 "15-25k" 格式
  const m = salaryDesc.match(/(\d+)[Kk]\s*[-~]\s*(\d+)[Kk]/);
  if (m) return [parseInt(m[1]!), parseInt(m[2]!)];
  // 匹配 "25K以上"
  const m2 = salaryDesc.match(/(\d+)[Kk]\s*以上/);
  if (m2) return [parseInt(m2[1]!), 9999];
  return null;
}

// 解析 publishedWithin 为 ms
function parseWithinMs(within: string): number {
  const m = within.match(/^(\d+)(h|d)$/);
  if (!m) return 3 * 60 * 60 * 1000; // 默认3小时
  const n = parseInt(m[1]!);
  return m[2] === "h" ? n * 3600000 : n * 86400000;
}

export function filterByConditions(jobs: JobItem[], filters: Filters): JobItem[] {
  const now = Date.now();
  return jobs.filter((job) => {
    // 薪资过滤
    if (filters.salary && (filters.salary.min !== undefined || filters.salary.max !== undefined)) {
      const parsed = parseSalaryK(job.salaryDesc);
      if (parsed) {
        const [jobMin] = parsed;
        if (filters.salary.min !== undefined && jobMin < filters.salary.min) return false;
        if (filters.salary.max !== undefined && jobMin > filters.salary.max) return false;
      }
    }

    // 发布时间过滤
    if (filters.publishedWithin && job.lastModifyTime) {
      const withinMs = parseWithinMs(filters.publishedWithin);
      if (now - job.lastModifyTime > withinMs) return false;
    }

    return true;
  });
}

// 持久化去重，基于 encryptJobId
let dedupeInstance: ReturnType<typeof createPersistentDedupe> | null = null;

function getDedupeInstance() {
  if (!dedupeInstance) {
    dedupeInstance = createPersistentDedupe({
      ttlMs: 7 * 24 * 3600 * 1000, // 7天后忘记，允许重复推送
      memoryMaxSize: 2000,
      fileMaxEntries: 5000,
      resolveFilePath: (ns) => join(getStateDir(), `dedupe-${ns}.json`),
    });
  }
  return dedupeInstance;
}

/**
 * 过滤已推送的岗位，并将新岗位标记为已见
 * 返回真正的"新"岗位
 */
export async function deduplicateJobs(jobs: JobItem[]): Promise<JobItem[]> {
  const dedupe = getDedupeInstance();
  const newJobs: JobItem[] = [];

  for (const job of jobs) {
    const isNew = await dedupe.checkAndRecord(job.encryptJobId, { namespace: "jobs" });
    if (isNew) {
      newJobs.push(job);
    }
  }

  return newJobs;
}
