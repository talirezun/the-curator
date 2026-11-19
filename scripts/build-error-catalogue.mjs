#!/usr/bin/env node
/**
 * build-error-catalogue.mjs: writes the published error catalogue.
 *
 *   node scripts/build-error-catalogue.mjs           rewrite both pages
 *   node scripts/build-error-catalogue.mjs --check   exit 1 if either is out of date
 *
 * Two pages carry it, each between the markers
 *   <!-- error-catalogue:begin --> … <!-- error-catalogue:end -->
 * and nothing outside the markers is touched:
 *   docs/errors.md               people: code · the exact sentence · what it means · what to do
 *   llm-docs/curator-errors.md   the website assistant: code · what it means · what to do (compact)
 *
 * WHY GENERATED. A person searches the page for the code under their error
 * ("code: sync-token-rejected") or for the words they see. A sentence copied
 * by hand drifts the first time the code changes, and then the page tells a
 * person something the app no longer says. So "what you see" is never typed
 * here: it is produced by calling the SAME functions the app calls:
 *   · USER_MESSAGES / SURFACE_MESSAGES (src/public/next/shared/user-errors.js)
 *   · describeSyncError (src/brain/sync.js), driven with a git text that the
 *     classifier maps to each code (the run throws if a text maps elsewhere)
 *   · REPLACE_TOKEN_MESSAGES (src/brain/sync.js), the Replace token refusals.
 *   · SHAREDBRAIN_TOKEN_MESSAGES (src/brain/sharedbrain-token.js), Shared
 *     Brain's Replace token refusals.
 * Only "what it means" and "what to do" are written by hand, below, keyed by
 * code. The run THROWS when a catalogue code (CATALOGUE_CODES) has no entry
 * here or an entry names a code the app does not have, so the page lists
 * every code exactly once. scripts/test-error-catalogue.js holds it to that.
 *
 * Importing sync.js reads no user data and starts no git: describeSyncError
 * is string matching, and the Replace token sentences are a frozen object.
 */

import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  USER_MESSAGES, SURFACE_MESSAGES, CATALOGUE_CODES,
} from '../src/public/next/shared/user-errors.js';
import { describeSyncError, REPLACE_TOKEN_MESSAGES } from '../src/brain/sync.js';
import { SHAREDBRAIN_TOKEN_MESSAGES } from '../src/brain/sharedbrain-token.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DOCS_PAGE = path.join(ROOT, 'docs', 'errors.md');
export const LLM_PAGE = path.join(ROOT, 'llm-docs', 'curator-errors.md');
export const BEGIN = '<!-- error-catalogue:begin -->';
export const END = '<!-- error-catalogue:end -->';

// What a placeholder in a sentence reads as on the page. In the app the
// bracket is filled in: "Anthropic", "index.md", "GitHub".
export const PLACEHOLDERS = Object.freeze({
  provider: '[AI provider]',
  name: '[file name]',
  service: '[service]',
  repo: '[repository]',
});

// ── Sync: a git text per code, as git prints it (sync.js's comments record
// the measured texts). describeSyncError must map each to its code. ────────
const SYNC_TRIGGERS = {
  'sync-token-rejected': "fatal: could not read Password for 'https://***@github.com': terminal prompts disabled",
  'sync-token-no-access': 'fatal: unable to access: The requested URL returned error: 403',
  'sync-repo-not-found': 'remote: Repository not found.',
  'sync-offline': 'fatal: Could not resolve host: github.com',
  'sync-remote-ahead': '! [rejected] main -> main (non-fast-forward)',
  'sync-busy-retry': "error: cannot lock ref 'refs/remotes/origin/main'",
  'sync-held-back-collision': 'error: Your local changes to the following files would be overwritten by merge',
  'sync-nested-repo': "error: 'notes/' does not have a commit checked out",
  'sync-git-missing': '/bin/sh: git: command not found',
  'sync-failed': 'an error text The Curator does not recognise',
};
// sync-merge-conflict has two sentences, one per situation.
const MERGE_CONFLICT_TRIGGERS = [
  'error: The following untracked working tree files would be overwritten by merge',
  'Automatic merge failed; fix conflicts and then commit the result.',
];

function syncSentence(code, text, opts) {
  const d = describeSyncError(new Error(text), opts);
  if (d.code !== code) throw new Error(`build-error-catalogue: the text for ${code} now maps to ${d.code}; update SYNC_TRIGGERS`);
  return d.error;
}

/**
 * Every sentence a person can see for `code`: [{label, text}], the first with
 * no label (what most people see), the rest labelled by where they appear.
 */
export function sentencesFor(code) {
  const P = PLACEHOLDERS;
  const ctx = { provider: P.provider, name: P.name, service: P.service };
  if (Object.prototype.hasOwnProperty.call(USER_MESSAGES, code)) {
    const out = [{ label: '', text: USER_MESSAGES[code](ctx) }];
    if (code === 'git-other') out.push({ label: 'On the Sync page', text: USER_MESSAGES[code]({ ...ctx, area: 'sync' }) });
    if (code === 'ai-too-long') {
      for (const [surface, label] of [['ingest', 'When ingesting'], ['chat', 'In chat'], ['compile', 'In Compile to Wiki']]) {
        out.push({ label, text: USER_MESSAGES[code]({ ...ctx, surface }) });
      }
    }
    const admin = SURFACE_MESSAGES.sharedbrain && SURFACE_MESSAGES.sharedbrain.admin;
    if (admin && admin[code]) out.push({ label: 'On an admin’s screen', text: admin[code](ctx) });
    return out;
  }
  if (Object.prototype.hasOwnProperty.call(REPLACE_TOKEN_MESSAGES, code)) {
    const v = REPLACE_TOKEN_MESSAGES[code];
    return [{ label: '', text: typeof v === 'function' ? v(P.repo) : v }];
  }
  if (Object.prototype.hasOwnProperty.call(SHAREDBRAIN_TOKEN_MESSAGES, code)) {
    const v = SHAREDBRAIN_TOKEN_MESSAGES[code];
    return [{ label: '', text: typeof v === 'function' ? v(P.repo) : v }];
  }
  if (code === 'sync-merge-conflict') {
    return MERGE_CONFLICT_TRIGGERS.map((t, i) => ({ label: i ? 'Or, for a conflict inside a page' : '', text: syncSentence(code, t) }));
  }
  if (Object.prototype.hasOwnProperty.call(SYNC_TRIGGERS, code)) {
    const out = [{ label: '', text: syncSentence(code, SYNC_TRIGGERS[code]) }];
    if (code === 'sync-token-rejected') {
      out.push({ label: 'On the Connect form', text: syncSentence(code, SYNC_TRIGGERS[code], { context: 'connect' }) });
      out.push({ label: 'In the notice shown on another page', text: syncSentence(code, SYNC_TRIGGERS[code], { context: 'elsewhere' }) });
    }
    if (code === 'sync-failed') {
      out.push({ label: 'When disconnecting', text: syncSentence(code, SYNC_TRIGGERS[code], { context: 'disconnect' }) });
    }
    return out;
  }
  throw new Error(`build-error-catalogue: no source for the sentence of ${code}`);
}

// ── The hand-written half: where, what it means, what to do. ────────────────
// `section` groups the page. Keep `means` and `todo` short: the assistant's
// copy carries them on every answer it gives.
export const SECTIONS = [
  ['sync', 'Sync', 'Messages on the Sync page and on its Connect form.'],
  ['token', 'Sync: replacing the token', 'Messages in the Replace token panel on the Sync page. In every case but one (sync-token-save-partial), Sync keeps the token it had.'],
  ['ai', 'AI providers and keys', 'Messages from ingest, chat, compile, Wiki health’s AI help and Verify AI connection, when the AI provider (Anthropic, Gemini or OpenRouter) refuses or fails.'],
  ['files', 'Files and folders', 'Messages when this computer will not let The Curator read or save a file in your knowledge folder.'],
  ['sharedbrain', 'Shared Brain', 'Messages when GitHub refuses or fails a Shared Brain request.'],
  ['sbtoken', 'Shared Brain: replacing the token', 'Messages in the Replace token panel on a Shared Brain’s card. In each case the Shared Brain keeps the token it had.'],
  ['network', 'Internet connection', 'Messages when The Curator cannot reach a service other than your AI provider.'],
  ['app', 'The Curator itself', 'Messages about the app, not about your knowledge: it is not running, an old version is still running, or something went wrong inside it.'],
];

export const ENTRIES = {
  // ── Sync ──
  'sync-token-rejected': { section: 'sync',
    means: 'GitHub refused the token Sync has saved. It has usually expired or been deleted. Your files stay on this computer.',
    todo: 'Create a new token on GitHub, then use Replace token on the Sync page (it opens under this message). On the Connect form, check the token and press Connect again. The Sync icon’s tooltip says so too when the background check finds it.' },
  'sync-token-no-access': { section: 'sync',
    means: 'GitHub knows the token, but it is not allowed to write to this repository.',
    todo: 'Give the token Contents: Read and write on the repository (fine-grained) or the repo scope (classic), then use Replace token, which opens under this message.' },
  'sync-repo-not-found': { section: 'sync',
    means: 'GitHub has no repository at that address, or the token cannot see it.',
    todo: 'Open the address in your browser to check it exists, and that the token has access to it.' },
  'sync-offline': { section: 'sync',
    means: 'The Curator could not reach GitHub.',
    todo: 'Check the internet connection. Some networks block git; try another one.' },
  'sync-remote-ahead': { section: 'sync',
    means: 'GitHub has changes this computer does not have yet, so a push was refused.',
    todo: 'Press Pull only (or Sync now, which pulls first), then push again.' },
  'sync-merge-conflict': { section: 'sync',
    means: 'What GitHub sent would overwrite files on this computer, or the same lines changed in both places. Sync stopped rather than choose for you.',
    todo: 'Copy your domains folder somewhere safe before syncing again, then follow the merge-conflict steps in the Sync guide, or ask for help.' },
  'sync-busy-retry': { section: 'sync',
    means: 'Another sync check (for example the MCP server or a second copy of the app) ran at the same moment. Nothing was changed.',
    todo: 'Wait a moment, then try again.' },
  'sync-held-back-collision': { section: 'sync',
    means: 'A file Sync does not send (one that looks like a secret) was changed here and on GitHub. Nothing was replaced.',
    todo: 'See What Sync does not back up on the Sync page, move that file out of your knowledge folder, then sync again.' },
  'sync-nested-repo': { section: 'sync',
    means: 'A folder inside your knowledge folder has its own git history, so Sync cannot back it up.',
    todo: 'Sync again. The Curator leaves that folder out and names it on the Sync page.' },
  'sync-git-missing': { section: 'sync',
    means: 'Git, which Sync uses, is not installed or not found.',
    todo: 'On a Mac, run `xcode-select --install` in Terminal, then try again.' },
  'sync-failed': { section: 'sync',
    means: 'Sync stopped for a reason The Curator does not recognise. Part of the run (for example changes already pulled) may have finished.',
    todo: 'Try again in a minute. If it repeats, send the Technical detail line to support.' },
  'git-other': { section: 'sync',
    means: 'A git step The Curator runs failed in a way it does not recognise.',
    todo: 'Try again. If it fails the same way, send the Technical detail line to support.' },
  'sync-token-missing': { section: 'token',
    means: 'Check and save was pressed with the token field empty.',
    todo: 'Paste the new token, then press Check and save.' },
  'sync-not-configured': { section: 'token',
    means: 'Sync is not connected on this computer, so there is no token to replace.',
    todo: 'Connect a repository on the Sync page first.' },
  'sync-token-invalid': { section: 'token',
    means: 'What was pasted does not look like a GitHub token. Nothing was changed.',
    todo: 'Copy the whole token from GitHub again (ghp_… or github_pat_…).' },
  'sync-config-unreadable': { section: 'token',
    means: 'The Curator could not read which repository Sync uses, so it could not check the token. Nothing was changed.',
    todo: 'Disconnect this repository and connect it again with the new token. Your wiki files stay as they are.' },
  'sync-new-token-rejected': { section: 'token',
    means: 'GitHub refused the new token. Sync keeps the token it had.',
    todo: 'Check that you copied all of it and that it has not expired, then try again.' },
  'sync-new-token-no-access': { section: 'token',
    means: 'The new token is valid but cannot open Sync’s repository (GitHub answers a private repository it cannot see as not found). Nothing was changed.',
    todo: 'Give the token that repository with Contents: Read and write (fine-grained) or the repo scope (classic).' },
  'sync-new-token-org-blocked': { section: 'token',
    means: 'For a github.com repository, GitHub accepted the new token but answered that the organisation owning the repository keeps it out: single sign-on (SAML) not yet authorised for this token, a fine-grained token waiting for an owner’s approval, or another organisation rule. Nothing was changed.',
    todo: 'Single sign-on: on GitHub’s token settings page, press Configure SSO next to the token and authorise it for the organisation. Fine-grained token: ask an organisation owner to approve it. Then try again.' },
  'sync-token-check-redirected': { section: 'token',
    means: 'For a github.com repository, GitHub answered the check with a redirect The Curator does not follow: to an address outside GitHub’s API, or one redirect after another. A renamed or transferred repository is followed (it stays on GitHub’s API). The token was not sent anywhere else. Nothing was changed.',
    todo: 'Check that the repository still exists on GitHub, then try again. If it repeats, send the Technical detail line to support.' },
  'sync-new-token-read-only': { section: 'token',
    means: 'For a github.com repository, The Curator asks GitHub what the new token may do. This one can read the repository but not write to it, so Sync could not send changes. Nothing was changed.',
    todo: 'Create a token with Contents: Read and write on that repository (fine-grained) or the repo scope (classic), then try again.' },
  'sync-token-check-rate-limited': { section: 'token',
    means: 'GitHub is limiting requests, so it did not answer the check of the new token. Nothing was changed.',
    todo: 'Wait a few minutes, then try again.' },
  'sync-token-check-offline': { section: 'token',
    means: 'The Curator could not reach GitHub to check the new token. Nothing was changed.',
    todo: 'Check the internet connection, then try again.' },
  'sync-token-check-failed': { section: 'token',
    means: 'The new token could not be checked, for another reason. Nothing was changed.',
    todo: 'Try again in a minute. If it repeats, send the Technical detail line to support.' },
  'sync-token-save-failed': { section: 'token',
    means: 'GitHub accepted the new token, but The Curator could not save it, and put back what it had started to change. Sync keeps the token it had.',
    todo: 'Try again. If it repeats, send the Technical detail line to support.' },
  'sync-token-save-partial': { section: 'token',
    means: 'The token is kept in two places (the sync history folder and Sync’s settings file). The new one was saved in the first, the second could not be written, and putting the first back failed too. Until both match, Sync may fail.',
    todo: 'Use Replace token again with the same new token. If that fails too, send the Technical detail line to support.' },

  // ── AI providers and keys ──
  'ai-key-rejected': { section: 'ai',
    means: 'The provider refused the API key: it is wrong, deleted or expired. The request was not charged.',
    todo: 'Settings › Providers & keys › Replace key (the button reads Add key when no key is saved in Settings). Verify AI connection in Settings › General checks it.' },
  'ai-no-credit': { section: 'ai',
    means: 'The provider account has no credit left. The request was not charged.',
    todo: 'Add credit on the provider’s website, or switch provider in Settings › Providers & keys.' },
  'ai-rate-limited': { section: 'ai',
    means: 'The provider is limiting how many requests the account may make (a free tier’s quota, for example).',
    todo: 'Wait a minute and try again, or switch provider in Settings › Providers & keys.' },
  'ai-overloaded': { section: 'ai',
    means: 'The provider is having problems on its side.',
    todo: 'Wait a few minutes, then try again.' },
  'ai-unreachable': { section: 'ai',
    means: 'The Curator could not connect to the provider.',
    todo: 'Check the internet connection (and any VPN or firewall), then try again.' },
  'ai-timeout': { section: 'ai',
    means: 'The provider took too long to answer. It may still bill the request.',
    todo: 'Try again in a few minutes.' },
  'ai-model-unavailable': { section: 'ai',
    means: 'The provider says the chosen model is not available.',
    todo: 'Pick another model in Settings › Providers & keys.' },
  'ai-too-long': { section: 'ai',
    means: 'The text is more than the model can read at once. The request was not charged.',
    todo: 'Pick a model that reads more. When ingesting, split the source into smaller files; in chat, start a New chat; in Compile to Wiki, compile with a model that reads more.' },
  'ai-bad-answer': { section: 'ai',
    means: 'The model answered, but not in a form The Curator could read. That answer is charged.',
    todo: 'Try again; if it repeats, pick a different model.' },
  'ai-provider-error': { section: 'ai',
    means: 'The provider could not complete the request, for another reason.',
    todo: 'Try again in a few minutes, or pick a different model or provider.' },

  // ── Files and folders ──
  'files-not-allowed': { section: 'files',
    means: 'This computer refused access to a file: the folder is read-only, or macOS privacy settings block The Curator.',
    todo: 'Allow The Curator in System Settings › Privacy & Security › Files and Folders, or make the folder writable.' },
  'files-disk-full': { section: 'files',
    means: 'The disk is full.',
    todo: 'Free some space, then try again.' },
  'files-missing': { section: 'files',
    means: 'A file or folder is not where The Curator expects it: moved, renamed, deleted, or not yet downloaded from iCloud or Dropbox.',
    todo: 'Check it is there. If you moved the knowledge folder, choose its new place in Settings › Knowledge base.' },
  'files-exists': { section: 'files',
    means: 'Something with that name is already there.',
    todo: 'Choose another name, or move the existing one first.' },
  'files-busy': { section: 'files',
    means: 'A file is in use or still downloading from cloud storage.',
    todo: 'Wait a moment, then try again.' },
  'files-name-too-long': { section: 'files',
    means: 'A file name is longer than this computer allows.',
    todo: 'Use a shorter name.' },
  'files-read-only-disk': { section: 'files',
    means: 'The disk is read-only.',
    todo: 'Choose a knowledge folder on a writable disk in Settings › Knowledge base.' },
  'files-wrong-kind': { section: 'files',
    means: 'A folder was expected and a file found, or the other way round, usually after a rename outside The Curator.',
    todo: 'Check the name in the message, then try again.' },

  // ── Shared Brain ──
  'github-token-rejected': { section: 'sharedbrain',
    means: 'GitHub refused the access token this computer uses for the Shared Brain. It has usually expired or been deleted.',
    todo: 'Create a new token on GitHub (an admin’s, and a contributor’s, needs Contents: Read and write), then use Replace token on that Shared Brain’s card (Domains › its shared-… mirror, or a domain you contribute from › Shared Brain). It opens under the message. You stay a member, and an admin keeps their admin token.' },
  'github-not-found': { section: 'sharedbrain',
    means: 'GitHub cannot find the Shared Brain’s repository, or the token cannot see it.',
    todo: 'A member asks whoever invited them to check access; an admin checks the repository and the token on GitHub. If the token needs changing, use Replace token on that Shared Brain’s card.' },
  'github-busy': { section: 'sharedbrain',
    means: 'GitHub is limiting requests from this token for now.',
    todo: 'Wait a few minutes, then try again.' },
  'github-unavailable': { section: 'sharedbrain',
    means: 'GitHub is having problems on its side.',
    todo: 'Wait a few minutes, then try again.' },

  // ── Shared Brain: replacing the token ──
  'sharedbrain-token-missing': { section: 'sbtoken',
    means: 'Check and save was pressed with an empty field.',
    todo: 'Paste the new token, then press Check and save.' },
  'sharedbrain-token-invalid': { section: 'sbtoken',
    means: 'What was pasted is not shaped like a GitHub token (often only part of it, or extra text).',
    todo: 'Copy the whole token from GitHub and paste it again.' },
  'sharedbrain-token-not-github': { section: 'sbtoken',
    means: 'This Shared Brain is kept in a folder, not on GitHub, so it has no GitHub token.',
    todo: 'Nothing to do.' },
  'sharedbrain-new-token-rejected': { section: 'sbtoken',
    means: 'GitHub refused the new token: it is incomplete, expired or deleted.',
    todo: 'Copy the token again, check its expiry date on GitHub, and try again.' },
  'sharedbrain-new-token-no-access': { section: 'sbtoken',
    means: 'GitHub knows the token, but it cannot open this Shared Brain’s repository.',
    todo: 'Give the token the repository with Contents: Read and write (fine-grained) or the repo scope (classic). A member also checks they accepted the GitHub invitation.' },
  'sharedbrain-new-token-read-only': { section: 'sbtoken',
    means: 'The new token can read the repository but not write to it, and this connection pushes contributions (a contributor’s or an admin’s).',
    todo: 'Give the token Contents: Read and write on the repository, then try again.' },
  'sharedbrain-token-check-rate-limited': { section: 'sbtoken',
    means: 'GitHub is limiting requests from this token, so it could not be checked.',
    todo: 'Wait a few minutes, then try again.' },
  'sharedbrain-token-check-offline': { section: 'sbtoken',
    means: 'The Curator could not reach GitHub to check the new token.',
    todo: 'Check the internet connection, then try again.' },
  'sharedbrain-token-check-failed': { section: 'sbtoken',
    means: 'GitHub answered in a way The Curator did not expect, so the token was not checked.',
    todo: 'Try again in a minute. If it keeps happening, send the Technical detail line to support.' },
  'sharedbrain-token-save-failed': { section: 'sbtoken',
    means: 'The new token works, but saving it on this computer failed.',
    todo: 'Try again. If it keeps happening, send the Technical detail line to support.' },

  // ── Internet ──
  'network-unreachable': { section: 'network',
    means: 'The Curator could not reach a service it needed (for example GitHub or the update check).',
    todo: 'Check the internet connection, then try again.' },
  'network-certificate': { section: 'network',
    means: 'The service’s security certificate could not be checked, often because of a company network, VPN or security software.',
    todo: 'Try another network.' },

  // ── The Curator itself ──
  'server-unreachable': { section: 'app',
    means: 'The page could not reach The Curator: it is restarting, was closed, or the computer slept.',
    todo: 'Wait a few seconds and try again. If it does not come back, quit The Curator and open it again.' },
  'server-outdated': { section: 'app',
    means: 'The Curator was updated, but the old version is still running.',
    todo: 'Quit The Curator and open it again.' },
  'api-route-missing': { section: 'app',
    means: 'The page asked for something the running version does not have, usually because an older version is still running.',
    todo: 'Quit The Curator and open it again.' },
  'request-failed': { section: 'app',
    means: 'A request came back with no usable answer.',
    todo: 'Try again. If it keeps failing, use Run system check in Settings › General.' },
  'request-too-large': { section: 'app',
    means: 'More was sent in one go than The Curator accepts (50 MB).',
    todo: 'Try a smaller selection.' },
  'request-malformed': { section: 'app',
    means: 'The Curator received a request it could not read.',
    todo: 'Reload the page, then try again.' },
  'internal-error': { section: 'app',
    means: 'Something went wrong inside The Curator (a bug).',
    todo: 'Try again. If it keeps happening, send the Technical detail line to support.' },
};

// ── Checks ──────────────────────────────────────────────────────────────────
export function catalogueProblems() {
  const problems = [];
  const sectionIds = new Set(SECTIONS.map((s) => s[0]));
  for (const code of CATALOGUE_CODES) {
    if (!ENTRIES[code]) problems.push(`no entry for catalogue code ${code}`);
  }
  for (const [code, e] of Object.entries(ENTRIES)) {
    if (!CATALOGUE_CODES.includes(code)) problems.push(`entry for ${code}, which is not a catalogue code`);
    if (!sectionIds.has(e.section)) problems.push(`${code}: unknown section ${e.section}`);
    if (!e.means || !e.todo) problems.push(`${code}: means and todo are both required`);
  }
  return problems;
}

// ── Rendering ───────────────────────────────────────────────────────────────
function cell(s) { return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }

function seenCell(code) {
  return sentencesFor(code).map((s, i) => (i === 0 ? cell(s.text) : `<br><br>*${s.label}:* ${cell(s.text)}`)).join('');
}

/** Codes in page order: by section, then in the order ENTRIES lists them. */
export function codesInOrder() {
  const out = [];
  for (const [id] of SECTIONS) {
    for (const code of Object.keys(ENTRIES)) if (ENTRIES[code].section === id && CATALOGUE_CODES.includes(code)) out.push(code);
  }
  return out;
}

export function renderDocsRegion() {
  const lines = [BEGIN, '<!-- Generated by scripts/build-error-catalogue.mjs from the app\'s own sentences. Do not edit by hand: run `node scripts/build-error-catalogue.mjs`. -->', ''];
  for (const [id, title, intro] of SECTIONS) {
    lines.push(`## ${title}`, '', intro, '');
    lines.push('| Code | What you see | What it means | What to do |', '|---|---|---|---|');
    for (const code of codesInOrder()) {
      const e = ENTRIES[code];
      if (e.section !== id) continue;
      lines.push(`| \`${code}\` | ${seenCell(code)} | ${cell(e.means)} | ${cell(e.todo)} |`);
    }
    lines.push('');
  }
  lines.push(END);
  return lines.join('\n');
}

const LLM_HEADINGS = {
  sync: 'What do the Sync error codes mean?',
  token: 'What do the Replace token error codes mean?',
  ai: 'What do the AI provider error codes mean?',
  files: 'What do the file and folder error codes mean?',
  sharedbrain: 'What do the Shared Brain error codes mean?',
  sbtoken: 'What do the Shared Brain Replace token error codes mean?',
  network: 'What do the internet connection error codes mean?',
  app: 'What do the error codes about The Curator itself mean?',
};

export function renderLlmRegion() {
  const lines = [BEGIN, ''];
  for (const [id] of SECTIONS) {
    lines.push(`## ${LLM_HEADINGS[id]}`, '', '| Code | What it means | What to do |', '|---|---|---|');
    for (const code of codesInOrder()) {
      const e = ENTRIES[code];
      if (e.section !== id) continue;
      lines.push(`| ${code} | ${cell(e.means)} | ${cell(e.todo)} |`);
    }
    lines.push('');
  }
  lines.push(END);
  return lines.join('\n');
}

/** Replace the marked region of `text` with `region`; throws without exactly one pair of markers. */
export function spliceRegion(text, region) {
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b < 0 || e < 0 || e < b || text.indexOf(BEGIN, b + 1) >= 0 || text.indexOf(END, e + 1) >= 0) {
    throw new Error('build-error-catalogue: the page needs exactly one begin and one end marker');
  }
  return text.slice(0, b) + region + text.slice(e + END.length);
}

/** {docs, llm}: the page texts as they should be. */
export function expectedPages() {
  const problems = catalogueProblems();
  if (problems.length) throw new Error('build-error-catalogue: ' + problems.join('; '));
  return {
    docs: spliceRegion(readFileSync(DOCS_PAGE, 'utf8'), renderDocsRegion()),
    llm: spliceRegion(readFileSync(LLM_PAGE, 'utf8'), renderLlmRegion()),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const check = process.argv.includes('--check');
  const want = expectedPages();
  const stale = [];
  for (const [file, text] of [[DOCS_PAGE, want.docs], [LLM_PAGE, want.llm]]) {
    if (readFileSync(file, 'utf8') === text) continue;
    stale.push(path.relative(ROOT, file));
    if (!check) writeFileSync(file, text);
  }
  if (check) {
    if (stale.length) { console.error('Out of date: ' + stale.join(', ') + '. Run node scripts/build-error-catalogue.mjs'); process.exit(1); }
    console.log('The error catalogue is up to date.');
  } else {
    console.log(stale.length ? 'Rewrote: ' + stale.join(', ') : 'Already up to date.');
  }
}
