#!/usr/bin/env node
/**
 * my-curator — the neutral command.
 *
 * argv → a subcommand module, and nothing else. Every subcommand works with
 * THE APP NOT RUNNING, with no network and with no credential: it reads the
 * same local files the MCP bridge reads, through the same `src/brain` modules,
 * because `mcp/server.js` already proves that shape.
 *
 *   my-curator context   the project bootstrap, to stdout
 *   my-curator save      a complete handoff, from stdin, to the store
 *   my-curator hook      what an installed harness hook invokes
 *   my-curator doctor    what is wired on this machine (read-only, exit 0)
 *   my-curator resolve   which project this directory is
 *
 * ── THE BIN IS NAMESPACED, AND THAT IS A DECISION ──────────────────────────
 * `package.json` declares ONE name, `my-curator`. `curator` is the bin of
 * Elastic's `elasticsearch-curator` (≈57k downloads a week, `/usr/bin/curator`
 * on Debian, where it runs index retention) and of npm's `config-curator`.
 * Taking it unconditionally would shadow a widely-installed operations tool on
 * somebody's production machine. So this package never links it: not in a
 * postinstall, not on first run, not at all. `my-curator doctor --alias`
 * prints the command to make the short name yourself, and REFUSES to print it
 * when `curator` already resolves elsewhere.
 *
 * ── `--domains-path` IS INSTALLED BEFORE ANY SUBCOMMAND LOADS ──────────────
 * Exactly as `mcp/server.js` does it, and for the same reason recorded there:
 * `setCliDomainsDir` must be called BEFORE anything resolves a path, or the
 * read side and the write side can resolve different trees. The subcommand
 * modules are therefore dynamic imports — they are loaded after the setter
 * runs, never before.
 */
import { parseArgv, out, note, EXIT_OK, EXIT_USAGE } from '../src/cli/resolve.js';

const USAGE = `my-curator — your project's context and handoffs, from the shell.

  my-curator context [--project <domain/project>] [--scope <name>] [--json]
                     [--budget <bytes>] [--include index|changed|all] [--slugs a.md,b.md]
  my-curator save    [--project …] [--scope main] [-f <file>|-] [--headline "…"] [--dry-run]
                     the complete state arrives as a JSON object on stdin
  my-curator hook    <session-start|stop|pre-compact|session-end> --harness <id>
                     the harness payload arrives on stdin; its envelope leaves on stdout
  my-curator doctor  [--json] [--alias]
  my-curator resolve [--project …] [--json]
  my-curator install-hooks <harness> [--scope user|project|local] [--dry-run] [--allow-withheld]

  --domains-path <dir>   read a knowledge base other than the configured one
  --help                 on any subcommand

stdout is the product; every diagnostic is on stderr.
Exit: 0 fine · 1 the store refused · 2 a usage error, an ambiguous project, or a deliberate block.`;

const parsed = parseArgv(process.argv.slice(2));
const command = parsed._.shift();

if (!command || command === 'help' || parsed.flags.help === true && !command) {
  out(USAGE);
  process.exitCode = command ? EXIT_OK : EXIT_USAGE;
} else if (command === 'version' || command === '--version') {
  const { readFileSync } = await import('node:fs');
  let v = 'unknown';
  try {
    v = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch { /* an unreadable package.json is not worth failing over */ }
  out(v);
} else {
  // The domains folder, before anything resolves a path. A missing or blank
  // value is a NO-OP — running without the flag is the normal case, and both
  // sides then fall through to the stored setting exactly as they always have.
  const dp = parsed.flags.domainsPath;
  if (typeof dp === 'string' && dp) {
    const { setCliDomainsDir } = await import('../src/brain/config.js');
    setCliDomainsDir(dp);
  }

  const RUNNERS = {
    context: async () => (await import('../src/cli/context.js')).runContext,
    save: async () => (await import('../src/cli/save.js')).runSave,
    hook: async () => (await import('../src/cli/hook.js')).runHook,
    doctor: async () => (await import('../src/cli/doctor.js')).runDoctor,
    resolve: async () => (await import('../src/cli/resolve.js')).runResolve,
    'install-hooks': async () => (await import('../src/cli/install-hooks.js')).runInstallHooks,
  };

  if (!(command in RUNNERS)) {
    note(`my-curator: unknown command "${command}".\n\n${USAGE}`);
    process.exitCode = EXIT_USAGE;
  } else if (RUNNERS[command] === null) {
    note('my-curator install-hooks is not in this build.');
    process.exitCode = EXIT_USAGE;
  } else {
    try {
      const run = await RUNNERS[command]();
      // `process.exitCode`, NEVER `process.exit()`: on a pipe, stdout writes
      // are async and `process.exit()` discards everything past the pipe
      // buffer — measured in this repo by skills/build.mjs, which lost a
      // model-read document past 64 KB to exactly that. A truncated bootstrap
      // is the same defect wearing a different hat.
      process.exitCode = (await run(parsed)) ?? EXIT_OK;
    } catch (err) {
      note(`my-curator ${command}: ${err && err.stack ? err.stack : err}`);
      process.exitCode = 1;
    }
  }
}
