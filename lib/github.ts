import { DomainError } from "./domain";

export async function githubRead(repo: string, path?: string) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new DomainError("REPO_INVALID", "Repositorio inválido.");
  if (
    path &&
    (path.length > 500 || path.split("/").some((part) => part === ".."))
  )
    throw new DomainError("PATH_INVALID", "Ruta inválida.");
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const base = `https://api.github.com/repos/${repo}`;
  const meta = await fetch(base, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!meta.ok)
    throw new DomainError(
      "GITHUB_UNAVAILABLE",
      "No se pudo consultar ese repositorio público.",
      502,
    );
  const info = await meta.json();
  if (info.private)
    throw new DomainError(
      "PRIVATE_REPO_UNSUPPORTED",
      "Conecta una GitHub App para consultar repositorios privados.",
      403,
    );
  const resource = path
    ? `/contents/${path.split("/").map(encodeURIComponent).join("/")}`
    : "/commits?per_page=5";
  const response = await fetch(base + resource, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new DomainError(
      "GITHUB_RESOURCE_UNAVAILABLE",
      "El recurso no está disponible.",
      502,
    );
  const data = await response.json();
  if (path) {
    if (Array.isArray(data))
      return {
        repo,
        entries: data
          .slice(0, 60)
          .map((item) => ({ path: item.path, type: item.type })),
      };
    if (data.size > 100000)
      throw new DomainError(
        "FILE_TOO_LARGE",
        "El archivo supera el límite de lectura.",
      );
    return {
      repo,
      path,
      content:
        data.encoding === "base64"
          ? Buffer.from(data.content, "base64").toString("utf8").slice(0, 24000)
          : "Contenido no compatible",
    };
  }
  return {
    repo,
    description: info.description,
    url: info.html_url,
    commits: data.map(
      (item: {
        sha: string;
        commit: { message: string };
        html_url: string;
      }) => ({
        sha: item.sha,
        message: item.commit.message.slice(0, 2000),
        url: item.html_url,
      }),
    ),
  };
}
