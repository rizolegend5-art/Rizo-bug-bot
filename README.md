# RIZO BUG BOT

A Telegram bot with WhatsApp multi-session support, role-based access control, pairing flows, sub-bot deployment, and persistent JSON storage.

## Overview

This project is built with Node.js and uses:

- Grammy for Telegram bot handling
- Baileys-based WhatsApp session management
- JSON files as the storage layer
- modularized bot runtime for cleaner maintenance
- deployable sub-bots with their own runtime context

It is designed for a bot that can manage user access, premium/VVIP roles, WhatsApp session pairing, and flexible menu-driven actions.

## Rebranding

Most project identity settings are centralized in `src/config/config.js`. To rebrand the bot, update:

- `BRANDING.name` — full bot name used in menus, notes, and runtime logs
- `BRANDING.shortName` — compact name shown in menu headers
- `BRANDING.tagline` — project tagline
- `BRANDING.version` — displayed version
- `BRANDING.creator` — creator/owner label
- `BRANDING.emoji` — header identity emoji
- `BRANDING.footer` — footer text shown below menus
- `CUSTOM_EMOJI` — custom Telegram emoji IDs grouped by menu area

Runtime code should use these configuration values instead of adding brand names directly to source files.

## Project Structure

```text
Telegram - Godline/
├── .env
├── database/
│   ├── admin.json
│   ├── bots.json
│   ├── mode.json
│   ├── pairs.json
│   ├── premium.json
│   ├── users.json
│   └── backups/
├── sessions/
├── src/
│   ├── bootstrap.js
│   ├── bot/
│   │   ├── deploy.js
│   │   ├── handlers/
│   │   │   ├── index.js
│   │   │   ├── callbacks.js
│   │   │   ├── commands.js
│   │   │   └── runtime.js
│   │   ├── logger.js
│   │   ├── menu.js
│   │   ├── travas.js
│   │   ├── vvipCooldown.js
│   │   └── whatsapp.js
│   ├── config/
│   │   └── config.js
│   └── data/
│       └── database.js
├── package.json
├── package-lock.json
├── README.md
└── .gitignore
```

## Folder-by-Folder Explanation

### 1) `database/`

This folder stores the bot's persistence data in JSON files. It acts as the bot's data layer.

- `admin.json` — admin user list
- `premium.json` — premium users
- `users.json` — main user metadata and user registry
- `pairs.json` — WhatsApp pairing data between Telegram users and WhatsApp numbers
- `mode.json` — public/private mode state for the bot
- `bots.json` — deployed bot instances and installed bot metadata
- `backups/` — backup copies of database data for restore/debugging

This is where the bot keeps state between restarts, so the system can remember users, access roles, and pairing relationships.

### 2) `sessions/`

This folder stores WhatsApp authentication/session state used by Baileys.

- session files are generated per user or number
- they are important for keeping WhatsApp connections alive between restarts
- without these files, the bot often has to re-pair or re-authenticate devices

This is the main area for WhatsApp connection continuity.

### 3) `src/`

This is the main application code.

- `src/bootstrap.js` starts the system
- `src/config/` handles environment and branding configuration
- `src/bot/` contains Telegram + WhatsApp runtime logic
- `src/data/` contains the database abstraction layer

### 4) `src/config/`

#### `src/config/config.js`

This file holds project settings loaded from `.env`.

It exports values such as:

- `BOT_TOKEN` — Telegram bot token
- `OWNER_ID` — owner/admin Telegram ID
- `OWNER_USERNAME` — owner username
- `MENU_PHOTO_URL` / `MENU_VIDEO_URL` — menu media link
- `MENU_MEDIA_TYPE` — chooses between photo and video menu
- `BRANDING` — bot branding metadata like name, version, tagline, emoji
- `FORCE_JOIN_CHANNELS` — forced channel membership config
- `MAX_PAIR_PER_USER` — maximum pair count allowed per user

This file is the central configuration source for the project.

### 5) `src/data/`

#### `src/data/database.js`

This is the main database access layer.

It provides functions such as:

- getting/adding users
- adding admin users
- adding premium/VVIP users
- reading and writing bot mode
- saving pair records
- loading deployed bot information
- handling backup-safe database operations

In short, this file is the API that the rest of the app uses to read and write persistent values.

### 6) `src/bot/`

This directory contains the runtime logic for the Telegram bot and WhatsApp integration.

#### `src/bot/bootstrap.js`

There is no separate file with that exact name; the real app startup is in `src/bootstrap.js`.

#### `src/bot/logger.js`

Handles logs for the application.

It is used for:

- startup messages
- warnings
- errors
- WhatsApp connection status
- bot lifecycle messages

#### `src/bot/menu.js`

This file creates the Telegram menu layer: interactive buttons, message blocks, metadata, and UI design.

It is responsible for:

- sending bot menu/message cards
- formatting success/error notices
- rendering menu media blocks
- creating message views with branding

#### `src/bot/whatsapp.js`

This is the WhatsApp session manager.

It handles:

- creating WhatsApp clients
- restoring stored sessions
- reconnecting after restart
- pairing flow and session validation
- session cleanup on shutdown

This is one of the most important reliability files in the project.

#### `src/bot/deploy.js`

This manages deployed sub-bots / bot instances.

It is used for:

- restoring deployed bot runtime state
- reloading bot instances after changes
- keeping multi-instance bot architecture stable

#### `src/bot/vvipCooldown.js`

This file handles VVIP rate limits/cooldowns.

It tracks usage and enforces cooldown logic such as:

- how many times a VVIP sender can be used in a time window
- reset logic after cooldown expiry
- formatted cooldown messaging

#### `src/bot/travas.js`

This file is part of the runtime task or message flow system. In this codebase it acts as a helper/utility script related to bot automation flows.

#### `src/bot/handlers/index.js`

This is the handler entry point. It loads and registers the runtime, command, and callback handlers.

#### `src/bot/handlers/runtime.js`

This is the shared runtime core for the bot.

It centralizes:

- session access checks
- target resolution helpers
- action execution flow
- user/number normalization
- VVIP selector flow
- shared action utilities

This file keeps the larger logic from becoming cluttered in one huge file.

#### `src/bot/handlers/commands.js`

This file contains the command handlers.

Examples of logic here include:

- `/menu`
- `/pair`
- admin and premium actions
- VVIP management
- message dispatch flows
- command-based user access checks

#### `src/bot/handlers/callbacks.js`

This file handles Telegram callback interactions triggered by button presses.

For example it covers:

- VVIP selection
- action selection buttons
- cooldown reset flows
- button-driven state updates

## Main Components

### src/bootstrap.js

Main application entry point. It:

- starts the Telegram bot
- loads WhatsApp sessions
- restores deployed sub-bots
- handles hot reload for menu/handler changes
- shuts down resources cleanly on exit

### src/bot/handlers/index.js

Compatibility entry for the handler system. It loads the modular route files and keeps the original bot registration flow intact.

### src/bot/handlers/runtime.js

Contains the core runtime helpers and shared logic used by commands and callbacks.

### src/bot/handlers/commands.js

Handles command-based Telegram message logic such as:

- menu
- pairing
- admin actions
- premium/VVIP control
- broadcast or public mode-related commands

### src/bot/handlers/callbacks.js

Handles inline button callback routes and interactive UI actions.

### src/bot/menu.js

Responsible for building the Telegram UI and menu presentation, including branding and media config.

### src/bot/whatsapp.js

Handles WhatsApp session lifecycle, restore, connection state, and session cleanup.

### src/bot/deploy.js

Used to restore and manage deployed bot instances.

### src/data/database.js

Persists bot data such as:

- users
- admins
- premium users
- VVIP users
- pairing records
- bot mode state
- deployed bot metadata

### src/config/config.js

Stores environment configuration including:

- BOT_TOKEN
- OWNER_ID
- OWNER_USERNAME
- branding values
- media config
- force-join channel config

## Environment Setup

Create a `.env` file in the project root:

```env
BOT_TOKEN=your_telegram_bot_token
OWNER_ID=1234567890
OWNER_USERNAME=@your_username
MENU_MEDIA_TYPE=photo
MENU_PHOTO_URL=https://example.com/menu-photo.jpg
MENU_VIDEO_URL=https://example.com/menu-video.mp4
FORCE_JOIN_CHANNEL=@your_channel
```

### Notes

- `BOT_TOKEN` is required.
- `OWNER_ID` is required.
- `FORCE_JOIN_CHANNEL` can be empty if join enforcement is not needed.
- `MENU_MEDIA_TYPE` defaults to `photo` or `video` depending on the configured URL.

## Installation

Install dependencies:

```bash
npm install
```

Run the bot:

```bash
npm start
```

## Runtime Behavior

On startup, the bot will:

1. initialize the main Telegram bot
2. register handlers
3. restore stored WhatsApp sessions
4. load user and mode data from the JSON database
5. restore deployed bots if present

## Database and Session Data

The app stores important runtime state in:

- `database/` for persistent data
- `sessions/` for WhatsApp session state

This is important to keep the bot stable across restarts and after reconnects.

## Important Considerations

- The project is built for a private/internal automation workflow.
- Session credentials and bot tokens should be kept secure.
- Back up the `database/` and `sessions/` directories regularly.
- The bot supports hot reload for some bot files during development and debugging.

## License

This project is intended for internal/private use and is not published as a public package.
