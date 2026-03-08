// src/storage.ts
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk";
import type { PluginState } from "./types.js";

const STATE_DIR = join(homedir(), ".openclaw", "boss-zhipin");
const STATE_FILE = join(STATE_DIR, "state.json");

const DEFAULT_STATE: PluginState = {};

async function ensureDir(): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
}

export async function readState(): Promise<PluginState> {
  await ensureDir();
  const { value } = await readJsonFileWithFallback<PluginState>(STATE_FILE, DEFAULT_STATE);
  return value;
}

export async function writeState(state: PluginState): Promise<void> {
  await ensureDir();
  await writeJsonFileAtomically(STATE_FILE, state);
}

export async function updateState(patch: Partial<PluginState>): Promise<PluginState> {
  const current = await readState();
  const updated = { ...current, ...patch };
  await writeState(updated);
  return updated;
}

export function getStateDir(): string {
  return STATE_DIR;
}
