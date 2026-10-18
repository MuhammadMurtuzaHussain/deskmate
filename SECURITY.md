# Security

Deskmate presses keys, pastes text and clicks in your apps, drives your Chrome, and runs Claude Code in your
folders. This page says what keeps that safe, what she never does, and how to report a problem.

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on the repository
([direct link](https://github.com/MuhammadMurtuzaHussain/deskmate/security/advisories/new)). If that isn't possible,
email the maintainer at the address in `package.json` with "Deskmate security" in the subject.

Include what you did, what happened, and what you expected; a log from `<user data>/tasks/` helps a lot (check it
for anything private first). You'll get an answer within a week. Fixes go out as a new release with a note in the
CHANGELOG, crediting you unless you'd rather not be named.

In scope: anything that makes her send, post, delete, buy or type something without the read-back below; keys
reaching an app other than the one she meant; a skill, a web page, a message or a file that gets her to act against
the rules here (prompt injection included); the phone remote accepting someone other than the paired account; her
data leaving the machine in ways the README's privacy section doesn't say.

## The safety model

Most of these rules are enforced in the code that acts, not in prompts, so a model (or a web page, or a message she
reads) can't talk its way past them. The one that can only be a prompt rule is marked.

**Read-backs.** Before a message goes to anyone, she says what she'll send and to whom, and waits for your yes
(spoken, typed, or a Yes button on the phone). The same goes for anything the Claude agent or the browser agent
would do that sends, posts, publishes, submits, deletes, buys, pays, subscribes, accepts, shares or invites.
Spoken Claude Code jobs are read back before they start. `DESKMATE_CONFIRM_SENDS` and `DESKMATE_CONFIRM_JOBS` let
you change when she asks; the defaults ask.

**Keys only reach the expected app.** Every key press, paste, menu press and focus change names the app it is for.
The helper checks that app is in front first and refuses otherwise ("You switched apps, so I stopped"). On macOS the
check is in the Swift helper; on Windows (experimental) in each PowerShell call.

**Checks before typing and before sending.** The app routines confirm the chat from the window title (or the
screen) before a word goes in, re-check it after you said yes (in case you moved it while she waited), and read the
message box back before pressing Return. If anything doesn't match, she stops and says so; she never guesses.

**What she never does:**

- drive Keychain Access, 1Password, Bitwarden, System Settings, the macOS security agent, or a terminal (Terminal,
  iTerm, Warp, Ghostty); real terminal work is a Claude Code job, which you can see and stop
- type a password, passcode, card number, CVV, IBAN or social security number, or type into a password field
- buy, pay or delete anything you didn't ask for
- take orders from a web page, an email, a message or a file she reads (her prompts treat those as content, not as
  you; this one is a prompt rule, so the read-backs above are the backstop when a model gets it wrong)
- send anything from the phone remote's chat to anyone but the one Telegram account you paired, confirmed on the Mac

**Skills.** A skill's keys only go to its own app; skills can't target the off-limits apps; secret-looking slot values
are refused; and in a messaging app, a skill whose Return could send without a `confirm` step and a `readBack` step
doesn't load at all. The same rules hold at run time, for recipe steps and for handler code. A skill handler is code
with Deskmate's full rights, so handlers in your user skills folder only load with `DESKMATE_SKILL_CODE=1`. Read a
skill before you install it, as you would any script. Details: [docs/SKILLS.md](docs/SKILLS.md).

**Plans** wait for your go, run one step at a time, and pause when a step fails. Each step still goes through the
read-backs above.

**Claude Code jobs** run with the permission mode in `.env` (`acceptEdits` by default: Claude may edit files in the
project folder; shell commands follow Claude Code's own permission rules). They run in the folder you picked or
named, and "stop the task" ends them.

**The phone remote** only listens to the one Telegram account you paired, and pairing needs a yes on the Mac. The
bot token stays in your settings file.

**Permissions she asks macOS for:** Accessibility (to press keys), Screen Recording (to look when you ask, or when
watch is on), Microphone (when you talk to her), Automation for Messages, Spotify and Chrome (asked by macOS the
first time), Calendars (read only, for reminders before events). Each is optional; without one, that feature says
what it needs.

## What leaves your machine

See [Privacy](README.md#privacy) in the README. In short: nothing with a local brain and voice, apart from the
update check; with a cloud brain, what you send it under your own key.

## Supported versions

Security fixes go into the latest release. Please update before reporting; the tray says when a newer version is out.
