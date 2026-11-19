# The Curator — error messages and what to do

## How do I read an error message in The Curator?

Since version 3.99.2 every error is a plain sentence: what happened, whether anything was lost or charged (said only when the app knows), and the one next step, naming a button on that screen. Under many messages a smaller grey line reads "Technical detail (for support): …", sometimes ending "(code: …)". The technical text is the original message from the AI provider, GitHub, git or the computer, with recognised tokens, keys and the home folder's name removed; a person does not need to read it, and should copy the whole line when asking for help. The code names the message: look it up in the tables below. A message with no code was written for one exact situation and explains itself. Words in square brackets on the full list, such as [AI provider] or [file name], are filled in on screen. Agents using the MCP get the original technical text, not these sentences. The full list with each exact sentence: https://github.com/talirezun/the-curator/blob/main/docs/errors.md

<!-- error-catalogue:begin -->

## What do the Sync error codes mean?

| Code | What it means | What to do |
|---|---|---|
| sync-token-rejected | GitHub refused the token Sync has saved. It has usually expired or been deleted. Your files stay on this computer. | Create a new token on GitHub, then use Replace token on the Sync page (it opens under this message). On the Connect form, check the token and press Connect again. The Sync icon’s tooltip says so too when the background check finds it. |
| sync-token-no-access | GitHub knows the token, but it is not allowed to write to this repository. | Give the token Contents: Read and write on the repository (fine-grained) or the repo scope (classic), then use Replace token, which opens under this message. |
| sync-repo-not-found | GitHub has no repository at that address, or the token cannot see it. | Open the address in your browser to check it exists, and that the token has access to it. |
| sync-offline | The Curator could not reach GitHub. | Check the internet connection. Some networks block git; try another one. |
| sync-remote-ahead | GitHub has changes this computer does not have yet, so a push was refused. | Press Pull only (or Sync now, which pulls first), then push again. |
| sync-merge-conflict | What GitHub sent would overwrite files on this computer, or the same lines changed in both places. Sync stopped rather than choose for you. | Copy your domains folder somewhere safe before syncing again, then follow the merge-conflict steps in the Sync guide, or ask for help. |
| sync-busy-retry | Another sync check (for example the MCP server or a second copy of the app) ran at the same moment. Nothing was changed. | Wait a moment, then try again. |
| sync-held-back-collision | A file Sync does not send (one that looks like a secret) was changed here and on GitHub. Nothing was replaced. | See What Sync does not back up on the Sync page, move that file out of your knowledge folder, then sync again. |
| sync-nested-repo | A folder inside your knowledge folder has its own git history, so Sync cannot back it up. | Sync again. The Curator leaves that folder out and names it on the Sync page. |
| sync-git-missing | Git, which Sync uses, is not installed or not found. | On a Mac, run `xcode-select --install` in Terminal, then try again. |
| sync-failed | Sync stopped for a reason The Curator does not recognise. Part of the run (for example changes already pulled) may have finished. | Try again in a minute. If it repeats, send the Technical detail line to support. |
| git-other | A git step The Curator runs failed in a way it does not recognise. | Try again. If it fails the same way, send the Technical detail line to support. |

## What do the Replace token error codes mean?

| Code | What it means | What to do |
|---|---|---|
| sync-token-missing | Check and save was pressed with the token field empty. | Paste the new token, then press Check and save. |
| sync-not-configured | Sync is not connected on this computer, so there is no token to replace. | Connect a repository on the Sync page first. |
| sync-token-invalid | What was pasted does not look like a GitHub token. Nothing was changed. | Copy the whole token from GitHub again (ghp_… or github_pat_…). |
| sync-config-unreadable | The Curator could not read which repository Sync uses, so it could not check the token. Nothing was changed. | Disconnect this repository and connect it again with the new token. Your wiki files stay as they are. |
| sync-new-token-rejected | GitHub refused the new token. Sync keeps the token it had. | Check that you copied all of it and that it has not expired, then try again. |
| sync-new-token-no-access | The new token is valid but cannot open Sync’s repository (GitHub answers a private repository it cannot see as not found). Nothing was changed. | Give the token that repository with Contents: Read and write (fine-grained) or the repo scope (classic). |
| sync-new-token-read-only | For a github.com repository, The Curator asks GitHub what the new token may do. This one can read the repository but not write to it, so Sync could not send changes. Nothing was changed. | Create a token with Contents: Read and write on that repository (fine-grained) or the repo scope (classic), then try again. |
| sync-token-check-rate-limited | GitHub is limiting requests, so it did not answer the check of the new token. Nothing was changed. | Wait a few minutes, then try again. |
| sync-token-check-offline | The Curator could not reach GitHub to check the new token. Nothing was changed. | Check the internet connection, then try again. |
| sync-token-check-failed | The new token could not be checked, for another reason. Nothing was changed. | Try again in a minute. If it repeats, send the Technical detail line to support. |
| sync-token-save-failed | GitHub accepted the new token, but The Curator could not save it, and put back what it had started to change. Sync keeps the token it had. | Try again. If it repeats, send the Technical detail line to support. |
| sync-token-save-partial | The token is kept in two places (the sync history folder and Sync’s settings file). The new one was saved in the first, the second could not be written, and putting the first back failed too. Until both match, Sync may fail. | Use Replace token again with the same new token. If that fails too, send the Technical detail line to support. |

## What do the AI provider error codes mean?

| Code | What it means | What to do |
|---|---|---|
| ai-key-rejected | The provider refused the API key: it is wrong, deleted or expired. The request was not charged. | Settings › Providers & keys › Replace key (the button reads Add key when no key is saved in Settings). Verify AI connection in Settings › General checks it. |
| ai-no-credit | The provider account has no credit left. The request was not charged. | Add credit on the provider’s website, or switch provider in Settings › Providers & keys. |
| ai-rate-limited | The provider is limiting how many requests the account may make (a free tier’s quota, for example). | Wait a minute and try again, or switch provider in Settings › Providers & keys. |
| ai-overloaded | The provider is having problems on its side. | Wait a few minutes, then try again. |
| ai-unreachable | The Curator could not connect to the provider. | Check the internet connection (and any VPN or firewall), then try again. |
| ai-timeout | The provider took too long to answer. It may still bill the request. | Try again in a few minutes. |
| ai-model-unavailable | The provider says the chosen model is not available. | Pick another model in Settings › Providers & keys. |
| ai-too-long | The text is more than the model can read at once. The request was not charged. | Pick a model that reads more. When ingesting, split the source into smaller files; in chat, start a New chat; in Compile to Wiki, compile with a model that reads more. |
| ai-bad-answer | The model answered, but not in a form The Curator could read. That answer is charged. | Try again; if it repeats, pick a different model. |
| ai-provider-error | The provider could not complete the request, for another reason. | Try again in a few minutes, or pick a different model or provider. |

## What do the file and folder error codes mean?

| Code | What it means | What to do |
|---|---|---|
| files-not-allowed | This computer refused access to a file: the folder is read-only, or macOS privacy settings block The Curator. | Allow The Curator in System Settings › Privacy & Security › Files and Folders, or make the folder writable. |
| files-disk-full | The disk is full. | Free some space, then try again. |
| files-missing | A file or folder is not where The Curator expects it: moved, renamed, deleted, or not yet downloaded from iCloud or Dropbox. | Check it is there. If you moved the knowledge folder, choose its new place in Settings › Knowledge base. |
| files-exists | Something with that name is already there. | Choose another name, or move the existing one first. |
| files-busy | A file is in use or still downloading from cloud storage. | Wait a moment, then try again. |
| files-name-too-long | A file name is longer than this computer allows. | Use a shorter name. |
| files-read-only-disk | The disk is read-only. | Choose a knowledge folder on a writable disk in Settings › Knowledge base. |
| files-wrong-kind | A folder was expected and a file found, or the other way round, usually after a rename outside The Curator. | Check the name in the message, then try again. |

## What do the Shared Brain error codes mean?

| Code | What it means | What to do |
|---|---|---|
| github-token-rejected | GitHub refused the access token this computer uses for the Shared Brain. It has usually expired or been deleted. | Create a new token on GitHub (an admin’s, and a contributor’s, needs Contents: Read and write), then use Replace token on that Shared Brain’s card (Domains › its shared-… mirror, or a domain you contribute from › Shared Brain). It opens under the message. You stay a member, and an admin keeps their admin token. |
| github-not-found | GitHub cannot find the Shared Brain’s repository, or the token cannot see it. | A member asks whoever invited them to check access; an admin checks the repository and the token on GitHub. If the token needs changing, use Replace token on that Shared Brain’s card. |
| github-busy | GitHub is limiting requests from this token for now. | Wait a few minutes, then try again. |
| github-unavailable | GitHub is having problems on its side. | Wait a few minutes, then try again. |

## What do the Shared Brain Replace token error codes mean?

| Code | What it means | What to do |
|---|---|---|
| sharedbrain-token-missing | Check and save was pressed with an empty field. | Paste the new token, then press Check and save. |
| sharedbrain-token-invalid | What was pasted is not shaped like a GitHub token (often only part of it, or extra text). | Copy the whole token from GitHub and paste it again. |
| sharedbrain-token-not-github | This Shared Brain is kept in a folder, not on GitHub, so it has no GitHub token. | Nothing to do. |
| sharedbrain-new-token-rejected | GitHub refused the new token: it is incomplete, expired or deleted. | Copy the token again, check its expiry date on GitHub, and try again. |
| sharedbrain-new-token-no-access | GitHub knows the token, but it cannot open this Shared Brain’s repository. | Give the token the repository with Contents: Read and write (fine-grained) or the repo scope (classic). A member also checks they accepted the GitHub invitation. |
| sharedbrain-new-token-read-only | The new token can read the repository but not write to it, and this connection pushes contributions (a contributor’s or an admin’s). | Give the token Contents: Read and write on the repository, then try again. |
| sharedbrain-token-check-rate-limited | GitHub is limiting requests from this token, so it could not be checked. | Wait a few minutes, then try again. |
| sharedbrain-token-check-offline | The Curator could not reach GitHub to check the new token. | Check the internet connection, then try again. |
| sharedbrain-token-check-failed | GitHub answered in a way The Curator did not expect, so the token was not checked. | Try again in a minute. If it keeps happening, send the Technical detail line to support. |
| sharedbrain-token-save-failed | The new token works, but saving it on this computer failed. | Try again. If it keeps happening, send the Technical detail line to support. |

## What do the internet connection error codes mean?

| Code | What it means | What to do |
|---|---|---|
| network-unreachable | The Curator could not reach a service it needed (for example GitHub or the update check). | Check the internet connection, then try again. |
| network-certificate | The service’s security certificate could not be checked, often because of a company network, VPN or security software. | Try another network. |

## What do the error codes about The Curator itself mean?

| Code | What it means | What to do |
|---|---|---|
| server-unreachable | The page could not reach The Curator: it is restarting, was closed, or the computer slept. | Wait a few seconds and try again. If it does not come back, quit The Curator and open it again. |
| server-outdated | The Curator was updated, but the old version is still running. | Quit The Curator and open it again. |
| api-route-missing | The page asked for something the running version does not have, usually because an older version is still running. | Quit The Curator and open it again. |
| request-failed | A request came back with no usable answer. | Try again. If it keeps failing, use Run system check in Settings › General. |
| request-too-large | More was sent in one go than The Curator accepts (50 MB). | Try a smaller selection. |
| request-malformed | The Curator received a request it could not read. | Reload the page, then try again. |
| internal-error | Something went wrong inside The Curator (a bug). | Try again. If it keeps happening, send the Technical detail line to support. |

<!-- error-catalogue:end -->
