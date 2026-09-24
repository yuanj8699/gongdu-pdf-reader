export interface GitHubSource {
  provider: "github";
  repository: string;
  commit: string;
  path: string;
  blobSha: string;
  url: string;
  format: "pdf" | "markdown" | "code";
}
export interface GitHubRepo {
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
}
export interface GitHubEntry { name: string; path: string; type: "file" | "dir" | "unsupported"; size?: number }
export interface GitHubDirectory { repository: string; commit: string; path: string; entries: GitHubEntry[] }
