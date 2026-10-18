/* global ethers */
const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "ca_token";
const CHAIN_ID = 31337;

function setStep(n) {
  [1, 2, 3].forEach((i) => {
    const li = $("step" + i);
    li.className = i < n ? "done" : i === n ? "active" : "";
    li.querySelector(".dot").textContent = i < n ? "✓" : String(i);
  });
}

function showError(msg) {
  const a = $("alert");
  a.textContent = msg;
  a.className = "alert";
}
const clearError = () => $("alert").classList.add("hidden");

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function checkServer() {
  try {
    const h = await api("/api/health");
    const ok = h.deployed;
    $("statusDot").className = "status-dot " + (ok ? "up" : "down");
    $("statusText").textContent = ok
      ? `Connected to chain ${h.chainId} · block ${h.block}`
      : "Contract not deployed — run npm run deploy";
  } catch (e) {
    $("statusDot").className = "status-dot down";
    $("statusText").textContent = e.message;
  }
}

async function ensureChain() {
  const net = await new ethers.BrowserProvider(window.ethereum).getNetwork();
  if (Number(net.chainId) === CHAIN_ID) return;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x7a69" }] });
  } catch (err) {
    if (err.code === 4902 || /Unrecognized chain/i.test(err.message || "")) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0x7a69",
          chainName: "Hardhat Local",
          rpcUrls: ["http://127.0.0.1:8545"],
          nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
        }],
      });
    } else throw err;
  }
}

async function login() {
  clearError();
  const btn = $("loginBtn");
  if (!window.ethereum) return showError("MetaMask was not found. Install the MetaMask extension and reload this page.");
  if (!window.ethers) return showError("Could not load the ethers library. Run npm run deploy once, or check your internet connection.");
  btn.disabled = true;
  try {
    setStep(1);
    btn.textContent = "Waiting for wallet…";
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    await ensureChain();
    const signer = await new ethers.BrowserProvider(window.ethereum).getSigner();
    const address = await signer.getAddress();

    setStep(2);
    btn.textContent = "Confirm the signature in MetaMask…";
    const { message } = await api("/api/auth/nonce?address=" + encodeURIComponent(address));
    const signature = await signer.signMessage(message);

    btn.textContent = "Verifying…";
    const session = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ address, signature }) });
    sessionStorage.setItem(TOKEN_KEY, session.token);
    setStep(3);
    btn.textContent = "Signed in ✓";
    location.href = "index.html";
  } catch (e) {
    setStep(1);
    btn.disabled = false;
    btn.textContent = "Sign in with MetaMask";
    const rejected = e?.code === 4001 || e?.code === "ACTION_REJECTED";
    showError(rejected ? "You cancelled the request in MetaMask. Try again when you're ready." : e?.shortMessage || e?.message || "Sign-in failed");
  }
}

async function skipIfSignedIn() {
  const t = sessionStorage.getItem(TOKEN_KEY);
  if (!t) return;
  try {
    await api("/api/me", { headers: { Authorization: "Bearer " + t } });
    location.replace("index.html");
  } catch {
    sessionStorage.removeItem(TOKEN_KEY);
  }
}

$("loginBtn").onclick = login;
if (window.ethereum?.on) window.ethereum.on("accountsChanged", () => sessionStorage.removeItem(TOKEN_KEY));
checkServer();
skipIfSignedIn();
