// Loads ethers from a CDN if the local copy (written by `npm run deploy`) is missing.
if (!window.ethers) {
  const s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js";
  document.head.appendChild(s);
}
