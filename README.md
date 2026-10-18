# TrueRoll – Decentralized Attendance dApp

A blockchain attendance system built with **Solidity + Hardhat + ethers.js** and a plain HTML/JS frontend that talks to **MetaMask**.

## How it works

| Role | Who | What they can do |
|------|-----|------------------|
| **Admin** | The account that deploys the contract | Add / remove teachers, close any session |
| **Teacher** | Added by admin (admin is a teacher too) | Create a timed attendance session, close own sessions |
| **Student** | Anyone, self-registers with name + unique roll no. | Mark themselves present once per open session |

Everything (students, sessions, who attended) is stored on-chain. Attendance can only be marked inside the session's time window and only once per student.

### What's new

- **Login page** (`/`): sign in with MetaMask by signing a free one-time message. The server verifies the signature, detects your role (admin / teacher / student / new) and opens the dashboard. No passwords. "Sign out" revokes the session token; switching wallet account signs you out.
- **Backend API** (`server/`): Node server with signed session tokens, per-request role checks, rate limiting, security headers and these endpoints:

  | Endpoint | Who | What |
  |---|---|---|
  | `GET /api/health` | public | chain + contract status |
  | `GET /api/auth/nonce`, `POST /api/auth/login`, `POST /api/auth/logout` | public / user | wallet sign-in |
  | `GET /api/me`, `/api/stats`, `/api/sessions`, `/api/activity` | any signed-in user | roles, class stats, sessions, activity feed |
  | `GET /api/students`, `/api/reports/low-attendance?threshold=75` | teacher/admin | per-student attendance, low-attendance report |
  | `GET /api/sessions/:id/attendees`, `/api/sessions/:id/export.csv` | admin, or the session's teacher | roll sheet (present + absent), CSV |
  | `GET /api/students/:addr/report`, `/api/students/:addr/export.csv` | the student themself, teacher/admin | per-session report, CSV |
  | `GET /api/admin/audit` | admin | sign-in log (kept in memory, cleared on restart) |

- **New contract features**: `extendSession`, `markStudentPresent` (teacher/admin manual override, e.g. wallet problems), `transferOwnership`, `getSessionsPage`, `getStudentReport`.
- **Dashboard**: extend/close sessions, roll sheet with "Mark present" for absent students, CSV downloads, student table with attendance bars and low-attendance filter, "My attendance report" for students, activity feed, admin sign-in log and "Make admin".

Note: students can no longer open other students' attendee lists from the UI; roll sheets are for the session's teacher and the admin. (The data is still public on-chain, as on any blockchain.)

## 1. Software to install

| Software | Version | Link |
|----------|---------|------|
| Node.js (includes npm) | 20 LTS or 22 LTS | https://nodejs.org |
| VS Code | latest | https://code.visualstudio.com |
| MetaMask browser extension | latest (Chrome / Edge / Brave / Firefox) | https://metamask.io/download |
| Git (optional) | any | https://git-scm.com |

VS Code extensions (VS Code will suggest them when you open the folder):
- **Solidity (Hardhat)** by Nomic Foundation – `NomicFoundation.hardhat-solidity`
- **ESLint** (optional)

Libraries (installed automatically by `npm install`, no manual step):
- `hardhat` – local blockchain, compiler, test runner
- `@nomicfoundation/hardhat-toolbox` – brings ethers v6, chai matchers, network helpers, etc.

> The first `npm install` and the first compile need internet (the Solidity 0.8.24 compiler is downloaded once).

## 2. Run it (open the folder in VS Code, use the built-in terminal: Ctrl + `)

```bash
# 1) install libraries
npm install

# 2) compile + run the tests
npx hardhat compile
npx hardhat test
npm run test:server   # backend helper tests (no blockchain needed)

# 3) start a local blockchain  (keep this terminal running)
npx hardhat node
```

Open a **second terminal** (the `+` button in the VS Code terminal panel):

```bash
# 4) deploy the contract to the local chain (writes frontend/contract.json)
npm run deploy

# 5) start the web app + API server
npm run start
```

Open **http://localhost:3000** in the browser where MetaMask is installed. You land on the login page.

Server settings (optional environment variables): `PORT`, `RPC_URL` (default `http://127.0.0.1:8545`), `JWT_SECRET` (set it to stay signed in across server restarts), `TOKEN_TTL_HOURS` (default 8).

## 3. Set up MetaMask for the local chain

1. The page will offer to add the network automatically. If not, add manually:
   - Network name: `Hardhat Local`
   - RPC URL: `http://127.0.0.1:8545`
   - Chain ID: `31337`
   - Currency symbol: `ETH`
2. Import test accounts: in the terminal running `npx hardhat node` you'll see 20 accounts with private keys.
   In MetaMask → account menu → **Import account** → paste a private key.
   - **Account #0** = Admin (deployer, also a teacher)
   - Import 2–3 more accounts to act as students / extra teachers.
   > These keys are public test keys. **Never send real funds to them.**
3. On the login page click **Sign in with MetaMask** and approve the signature.

## 4. Try the full flow

1. As **Account #0**: create a session ("Math – Lecture 1", 10 minutes).
2. Switch MetaMask to **Account #1** → reload → register as a student (name + roll no).
3. Click **Mark present** on the open session, confirm in MetaMask.
4. Switch back to Account #0 → **Attendees** button shows who was present.
5. (Admin) paste another account's address to make it a teacher.

## Troubleshooting

- **"Nonce too high" / transactions fail after restarting `hardhat node`**: MetaMask → Settings → Advanced → *Clear activity tab data*.
- **"No contract at the saved address"**: you restarted `hardhat node`; run `npm run deploy` again and reload the page.
- **Port 3000 busy**: `PORT=3001 npm run start` (Windows PowerShell: `$env:PORT=3001; npm run start`).
- **MetaMask not found**: open the page in a normal browser window with the extension, not inside VS Code's preview.

## Project layout

```
contracts/Attendance.sol     smart contract
test/Attendance.test.js      automated tests
scripts/deploy.js            deploys + writes frontend/contract.json
server/index.js              backend: static hosting + wallet login + REST API
server/lib/                  token (JWT), csv, rate limiter helpers (+ server/test)
frontend/login.html, login.js   login page
frontend/index.html, app.js     dashboard (MetaMask + ethers v6)
frontend/style.css              shared styles
hardhat.config.js            Hardhat config (Solidity 0.8.24)
```

## Going beyond localhost

To use a public testnet (e.g. Sepolia) add a network entry in `hardhat.config.js` with an RPC URL and a funded private key from an environment variable, deploy with `--network sepolia`, and point MetaMask to that network (the frontend asks for chain 31337, so change `CHAIN_ID` in `frontend/login.js` and `frontend/app.js`, and set `RPC_URL` for the server).
