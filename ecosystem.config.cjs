module.exports = {
  apps: [
    {
      // Keeps presence, typing and assignment-reminder state in memory (see server/src/presence.ts and
      // server/src/services/assignmentReminders.ts) — stays a single fork-mode instance. Splitting it into
      // multiple instances/cluster mode without a shared store (e.g. Redis) would make that state inconsistent
      // across workers, so `pm2 reload` here is not zero-downtime: it behaves like `pm2 restart` (see
      // scripts/deploy.sh, which restarts this one on its own and waits for /health before moving on).
      name: "support-server",
      cwd: "./server",
      script: "node",
      args: "../node_modules/tsx/dist/cli.mjs src/index.ts",
      env: {
        NODE_ENV: "production",
        PORT: 5000
      }
    },
    {
      // Stateless (renders pages and proxies /graphql, /socket.io, etc. to support-server) — safe to run as a
      // cluster, which is what makes `pm2 reload` here an actual zero-downtime rolling reload: PM2 starts the new
      // workers and only stops the old ones once the new ones are accepting connections, so the port is never
      // fully down.
      name: "support-client",
      cwd: "./client",
      script: "../node_modules/next/dist/bin/next",
      args: "start -p 4000",
      exec_mode: "cluster",
      instances: 2,
      env: {
        NODE_ENV: "production",
        PORT: 4000
      }
    }
  ]
};
