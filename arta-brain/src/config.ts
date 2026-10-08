import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Every setting the brain reads, in one place. On a Linux host they come from the systemd
 * EnvironmentFile (~/.config/arta-brain/env, mode 600 — see deploy/install.sh); on the operator's Mac
 * from ~/ArtaBrain/env (deploy/macos/arta-brain.sh). Nothing here ever
 * logs a value; `missing()` reports names only.
 *
 * There is deliberately NO paid model API in here. Arta answers only through the operator's
 * flat-rate chat subscription, driven in a signed-in browser profile on the VM. When that is
 * unavailable, mentions wait in the site's queue — nothing is ever billed per reply.
 */
export type Config = {
  wpBase: string;             // https://artaquest.com
  replyToken: string;         // = AQ_ARTA_REPLY_TOKEN on WordPress
  githubToken: string;        // fine-grained PAT, Issues read/write on githubRepo only
  githubRepo: string;         // owner/name
  bugsPerUserPerDay: number;
  bugsPerDay: number;
  dryRun: boolean;            // compose, but write nothing anywhere (smoke tests)

  chatUrl: string;            // the chat page the signed-in profile answers on (operator setting, not in the repo)
  profileDir: string;         // the persistent browser profile holding the sign-in
  stateDir: string;           // pacer state, heartbeat, probe screenshots
  headless: boolean;
  browserChannel: string;     // "" = Playwright's own Chromium; "chrome" = the installed Google Chrome (the Mac setup)
  modeLabels: string[];       // the picker's modes to try, highest effort first (ARTA_MODE_LABELS)
  stableSec: number;          // an answer counts as finished once unchanged this long with no stop control showing
  attachMax: number;          // files IN per mention (uploaded to the chat page)
  attachBytes: number;
  outFilesMax: number;        // files OUT per reply (generated images, the full long answer)
  outFileBytes: number;

  minGapSec: number;          // at least this long between two prompts
  perHour: number;            // prompts per rolling hour
  perDay: number;             // prompts per rolling 24 h
  answerTimeoutSec: number;   // one answer may take this long before it is abandoned
  pollSec: number;            // poll interval while there is work
  idlePollSec: number;        // poll interval while the queue is empty
  busyPauseSec: number;       // pause after the chat page reports a usage limit without saying until when
  downPauseSec: number;       // pause after the page is signed out / broken, before trying again

  // newChat: optional "new conversation" control, clicked when the page opens on an earlier conversation.
  // mode: the effort picker's button (default: the composer button labelled with a known mode name);
  // modeItem: its options; file: the attach control's file input; busy: what is visible while an answer
  // is still being written (the stop control); uploading: what is visible while an attachment uploads.
  sel: {
    input: string; send: string; answer: string; newChat: string; signedOut: string; limitText: string;
    mode: string; modeItem: string; attach: string; file: string; busy: string; uploading: string;
  };
};

const int = (v: string | undefined, d: number, min = 0) => {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n >= min ? n : d;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.HOME || homedir();
  return {
    wpBase: (env.WP_BASE_URL || "https://artaquest.com").replace(/\/+$/, ""),
    replyToken: env.ARTA_REPLY_TOKEN || "",
    githubToken: env.GITHUB_ISSUES_TOKEN || "",
    githubRepo: env.GITHUB_REPO || "ArtaQuest/artasite",
    bugsPerUserPerDay: int(env.BUGS_PER_USER_PER_DAY, 3),
    bugsPerDay: int(env.BUGS_PER_DAY, 40),
    dryRun: env.ARTA_DRY_RUN === "1",

    chatUrl: env.ARTA_CHAT_URL || "",
    profileDir: env.ARTA_PROFILE_DIR || join(home, ".local/share/arta-brain/profile"),
    stateDir: env.ARTA_STATE_DIR || join(home, ".local/state/arta-brain"),
    headless: env.ARTA_HEADLESS !== "0",
    browserChannel: env.ARTA_BROWSER_CHANNEL || "",
    modeLabels: (env.ARTA_MODE_LABELS ?? "Heavy,Expert,Thinking,Auto").split(",").map((x) => x.trim()).filter(Boolean),
    stableSec: int(env.ARTA_STABLE_SEC, 4, 2),
    attachMax: int(env.ARTA_ATTACH_MAX, 4, 0),
    attachBytes: int(env.ARTA_ATTACH_MB, 20, 1) * 1024 * 1024,
    outFilesMax: int(env.ARTA_OUT_FILES_MAX, 4, 0),
    outFileBytes: int(env.ARTA_OUT_FILE_MB, 10, 1) * 1024 * 1024,

    minGapSec: int(env.ARTA_MIN_GAP_SEC, 45, 5),
    perHour: int(env.ARTA_PER_HOUR, 30, 1),
    perDay: int(env.ARTA_PER_DAY, 300, 1),
    // The top-effort modes think for minutes before they write; 10 minutes is the default ceiling.
    answerTimeoutSec: int(env.ARTA_ANSWER_TIMEOUT_SEC, 600, 15),
    pollSec: int(env.ARTA_POLL_SEC, 10, 3),
    idlePollSec: int(env.ARTA_IDLE_POLL_SEC, 30, 5),
    busyPauseSec: int(env.ARTA_BUSY_PAUSE_SEC, 3600, 60),
    downPauseSec: int(env.ARTA_DOWN_PAUSE_SEC, 600, 60),

    sel: {
      input: env.ARTA_SEL_INPUT || 'textarea, div[contenteditable="true"]',
      send: env.ARTA_SEL_SEND || "",
      answer: env.ARTA_SEL_ANSWER || "",
      newChat: env.ARTA_SEL_NEW_CHAT || "",
      mode: env.ARTA_SEL_MODE || "",
      modeItem: env.ARTA_SEL_MODE_ITEM || '[role="menuitem"], [role="menuitemradio"], [role="option"]',
      attach: env.ARTA_SEL_ATTACH || "",
      file: env.ARTA_SEL_FILE || 'input[type="file"]',
      busy: env.ARTA_SEL_BUSY || 'button[aria-label*="stop" i]',
      uploading: env.ARTA_SEL_UPLOADING || '[role="progressbar"], [aria-busy="true"]',
      signedOut: env.ARTA_SEL_SIGNED_OUT || 'a[href*="login"], a[href*="signin"], a[href*="sign-in"]',
      // Also a mode's own allowance ("you've reached your <mode> limit"): it pauses Arta like any limit.
      limitText: env.ARTA_LIMIT_TEXT || "(reached|hit) (your|the) ([a-z0-9-]+ )?(usage |message |rate |query )?limit|out of (queries|messages)|too many (requests|messages)|try again (in|later)|limit resets",
    },
  };
}

/** Names of required settings that are missing — for `check`. Never values. */
export function missing(c: Config): string[] {
  const out: string[] = [];
  if (c.replyToken.length < 32) out.push("ARTA_REPLY_TOKEN");
  if (!/^https:\/\//.test(c.chatUrl)) out.push("ARTA_CHAT_URL");
  if (!c.sel.answer) out.push("ARTA_SEL_ANSWER");
  if (!c.githubToken) out.push("GITHUB_ISSUES_TOKEN");
  return out;
}
