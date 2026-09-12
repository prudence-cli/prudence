// Terminal character for the control plane (never the product surface).
// Rules: monochrome-safe glyphs only, no emoji anywhere near error paths
// (voice: calm bookkeeper), and ALL ornament gates behind isTTY — piped
// output (slash packs, scripts, tests) stays plain and token-cheap.

const TTY = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR?.length && process.env.TERM !== "dumb";

export const isTTY = TTY;

const COPPER = "\x1b[38;5;173m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function paint(code: string, text: string): string {
  return TTY ? `${code}${text}${RESET}` : text;
}

export const copper = (t: string): string => paint(COPPER, t);
export const dim = (t: string): string => paint(DIM, t);
export const bold = (t: string): string => paint(BOLD, t);

// Pru, perched. Monochrome geometry — reads at any width, costs 4 lines.
export const CROW = ["  ,", " (o)>", " /|\\ ", " ─╨─ "].join("\n");

export function crowLine(): string {
  if (!TTY) return "";
  return `${CROW}\n${copper("Pru")} ${dim("— the books are open.")}\n`;
}

// Coin meter: spent against limit as a bar plus exact figures.
// Figures are always printed; the bar is ornament.
export function coinBar(spentMicro: number, limitMicro: number, width = 18): string {
  const ratio = limitMicro > 0 ? Math.min(1, spentMicro / limitMicro) : 0;
  const filled = Math.round(ratio * width);
  const bar = "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
  return TTY ? copper(bar) : bar;
}

// Minimal spinner for genuine waits (network, batch polls). No-op off-TTY.
export function spinner(label: string): { stop: (done?: string) => void } {
  if (!TTY) return { stop: () => {} };
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r${copper(frames[i % frames.length])} ${dim(label)}`);
    i += 1;
  }, 80);
  return {
    stop: (done = "done") => {
      clearInterval(timer);
      process.stdout.write(`\r${copper("●")} ${label} — ${done}.\n`);
    },
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
