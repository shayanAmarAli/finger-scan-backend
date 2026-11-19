import { defineRailway, github, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "finger-scan-backend";
export default defineRailway(() => {
  const fingerScanBackend = service("finger-scan-backend", {
    // Deploy every push to main, but only after the GitHub Actions checks
    // pass ("Wait for CI"): a failing test blocks the deployment.
    source: github("shayanAmarAli/finger-scan-backend", { branch: "main", checkSuites: true }),
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile", watchPatterns: ["src/**", "package.json", "package-lock.json", "Dockerfile", "tsconfig*.json"] },
    healthcheck: "/health",
    healthcheckTimeout: 60,
    replicas: { "iad": 1 },
  });

  return project("finger-scan", {
    variables: { managed: false },
    resources: [fingerScanBackend],
  });
});
