const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with admin account:", deployer.address);

  const Attendance = await hre.ethers.getContractFactory("Attendance");
  const attendance = await Attendance.deploy();
  await attendance.waitForDeployment();
  const address = await attendance.getAddress();
  console.log("Attendance deployed to:", address);

  // Write ABI + address for the frontend
  const artifact = await hre.artifacts.readArtifact("Attendance");
  const frontendDir = path.join(__dirname, "..", "frontend");
  fs.mkdirSync(frontendDir, { recursive: true });
  fs.writeFileSync(
    path.join(frontendDir, "contract.json"),
    JSON.stringify({ address, abi: artifact.abi }, null, 2)
  );

  console.log("Wrote frontend/contract.json");

  // Copy the browser build of ethers so the frontend works without a CDN.
  // (index.html falls back to a CDN copy if this step is skipped.)
  try {
    let dir = path.dirname(require.resolve("ethers"));
    while (dir !== path.dirname(dir)) {
      const pj = path.join(dir, "package.json");
      if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, "utf8")).name === "ethers") break;
      dir = path.dirname(dir);
    }
    fs.copyFileSync(
      path.join(dir, "dist", "ethers.umd.min.js"),
      path.join(frontendDir, "ethers.umd.min.js")
    );
    console.log("Copied frontend/ethers.umd.min.js");
  } catch (e) {
    console.warn("Could not copy ethers browser build, frontend will use the CDN:", e.message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
