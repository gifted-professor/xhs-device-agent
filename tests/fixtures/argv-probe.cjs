if (process.env.XHS_ARGV_PROBE === "1") {
  process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\n`);
  process.exit(0);
}
