#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillsSource = path.resolve(__dirname, "..", "skills");

function die(msg: string): never {
  console.error(`\x1b[31mError:\x1b[0m ${msg}`);
  process.exit(1);
}

function findClaudeConfigDir(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;

  // Claude Code stores config in ~/.claude/
  const claudeDir = path.join(home, ".claude");
  if (fs.existsSync(claudeDir)) return claudeDir;

  return null;
}

function main(): void {
  console.log("\x1b[1mLiteboard Setup\x1b[0m\n");

  // Verify Claude Code is installed
  try {
    execFileSync("which", ["claude"], { stdio: "pipe" });
  } catch {
    die("Claude Code CLI not found. Install it first: https://docs.anthropic.com/en/docs/claude-code");
  }

  // Find Claude config directory
  const claudeDir = findClaudeConfigDir();
  if (!claudeDir) {
    die("Could not find Claude Code config directory (~/.claude/).");
  }

  // Verify skills source exists
  if (!fs.existsSync(skillsSource)) {
    die(`Skills directory not found at ${skillsSource}. Is liteboard installed correctly?`);
  }

  // Read available skills
  const skillFiles = fs.readdirSync(skillsSource).filter(f => f.endsWith(".md"));
  if (skillFiles.length === 0) {
    die("No skill files found in the skills/ directory.");
  }

  // Create commands directory for the plugin
  const commandsDir = path.join(claudeDir, "commands");
  if (!fs.existsSync(commandsDir)) {
    fs.mkdirSync(commandsDir, { recursive: true });
  }

  // Copy skill files as liteboard: prefixed commands
  for (const file of skillFiles) {
    const name = file.replace(".md", "");
    const destName = `liteboard:${name}.md`;
    const src = path.join(skillsSource, file);
    const dest = path.join(commandsDir, destName);
    fs.copyFileSync(src, dest);
    console.log(`  Installed: /liteboard:${name}`);
  }

  console.log(`\n\x1b[32mSetup complete!\x1b[0m ${skillFiles.length} skills installed.\n`);
  console.log("Available commands:");
  console.log("  /liteboard:brainstorm       Start a new project design");
  console.log("  /liteboard:task-manifest    Generate implementation manifest");
  console.log("  /liteboard:run              Launch orchestrator + supervisor\n");
}

main();
