import fs from "fs";

export function isContainerized(fileExists = fs.existsSync) {
  if (fileExists("/.dockerenv") || fileExists("/run/.containerenv")) {
    return true;
  }
  try {
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    return /docker|kubepods|containerd/.test(cgroup);
  } catch {
    return false;
  }
}

export function getContainerInfo() {
  return {
    isDocker: isContainerized(),
    hasDockerSocket: fs.existsSync("/var/run/docker.sock"),
  };
}
