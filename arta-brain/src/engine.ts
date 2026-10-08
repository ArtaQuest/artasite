import type { OutFile } from "./types";

/**
 * What answers Arta's prompts. The only production implementation is BrowserEngine (the operator's
 * signed-in chat subscription); tests use a fake. There is intentionally no paid-API engine.
 */
export type EngineAnswer = { text: string; files: OutFile[]; mode?: string };

export interface Engine {
  /**
   * One prompt in (plus local files to attach), the assistant's full text out — and any files it
   * produced. A plain string means text only. Throws EngineBusy / EngineDown / Error.
   */
  ask(prompt: string, timeoutMs: number, files?: string[]): Promise<string | EngineAnswer>;
  close(): Promise<void>;
}

/** The chat service said "not now" (usage limit). Nothing is wrong; wait until `until` (ms epoch). */
export class EngineBusy extends Error {
  constructor(public until: number, message = "chat usage limit reached") { super(message); }
}

/** The engine cannot work at all (signed out, page changed, browser gone). Needs a human or a restart. */
export class EngineDown extends Error {
  constructor(public reason: string) { super(`chat engine unavailable: ${reason}`); }
}
