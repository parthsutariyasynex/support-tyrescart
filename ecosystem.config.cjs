module.exports = {
  apps: [
    {
      name: "support-server",
      cwd: "./server",
      script: "node",
      args: "../node_modules/tsx/dist/cli.mjs src/index.ts",
      env: {
        NODE_ENV: "production",
        PORT: 5001
      }
    },
    {
      name: "support-client",
      cwd: "./client",
      script: "node",
      args: "../node_modules/next/dist/bin/next start -p 4000",
      env: {
        NODE_ENV: "production",
        PORT: 4000
      }
    }
  ]
};
