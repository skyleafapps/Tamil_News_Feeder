import cron from "node-cron";
import { exec } from "child_process";

// Runs every 1 hour (at minute 0)
cron.schedule("0 * * * *", () => {
  console.log("Running index.js at:", new Date().toLocaleString());

  exec("node index.js", (error, stdout, stderr) => {
    if (error) {
      console.error(`Error: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`Stderr: ${stderr}`);
      return;
    }
    console.log(`Output:\n${stdout}`);
  });
});

console.log("Cron job started. index.js will run every hour.");
