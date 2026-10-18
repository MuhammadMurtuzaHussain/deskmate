---
name: notes-new-note
description: Write a new note in Apple Notes. Use when the user asks to make, add, jot down or write something in Notes.
license: MIT
compatibility: macOS with Apple Notes; Deskmate runs it as the skill_notes_new_note tool (skill.json and handler.mjs)
metadata:
  author: deskmate
---

# New note

In Deskmate this is a ready-made routine: call `skill_notes_new_note` with `text`, the note as the user wants it.
The handler drops a trailing "in notes" and capitalizes the first letter.

## Steps (what the routine does, for any agent doing it by hand)
1. Open Notes, or bring it to the front.
2. Choose File › New Note.
3. Paste the text, then check the note holds it.

## App quirks
- The first line of a note becomes its title in the sidebar.
- File › New Note is greyed out while a sheet or the welcome screen is open: close it first.
