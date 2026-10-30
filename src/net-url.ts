// net-url.ts — small URL-authority helpers shared by src/init.ts and
// install.mjs. Upstream (tools/headlong-init and install.sh) duplicates
// these as literal Bash copies ("keep the copies identical" — both files'
// own comments say so); the port shares one implementation instead, since
// internals are free as long as the observable behavior at each call site
// matches. Plain bash parameter-expansion logic ported to string slicing:
// scheme, userinfo, port, path, query and fragment all fall away the same
// way `_url_host`/`_url_host_swap`/`_url_is_loopback`/`_url_safe_display` do.

/** The authority's host, with IPv6 brackets stripped. */
export function urlHost(url: string): string {
  const rest = url.includes("://") ? url.slice(url.indexOf("://") + 3) : url;
  const authority = rest.split(/[/?#]/)[0] ?? "";
  const hostport = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
  if (hostport.startsWith("[")) return hostport.slice(1, hostport.indexOf("]"));
  const c = hostport.indexOf(":");
  return c === -1 ? hostport : hostport.slice(0, c);
}

/** Drop userinfo, query and fragment — retains scheme, host, port, path. */
export function urlSafeDisplay(url: string): string {
  const hasScheme = url.includes("://");
  const scheme = hasScheme ? `${url.slice(0, url.indexOf("://"))}://` : "";
  const rest = hasScheme ? url.slice(url.indexOf("://") + 3) : url;
  const authMatch = /^[^/?#]*/.exec(rest);
  const authority = authMatch ? authMatch[0] : "";
  const hostport = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
  let tail = rest.slice(authority.length);
  tail = tail.split("?")[0]!.split("#")[0]!;
  return `${scheme}${hostport}${tail}`;
}

/** Replace ONLY the authority's host; scheme, userinfo, port and path survive. */
export function urlHostSwap(url: string, newHost: string): string {
  const hasScheme = url.includes("://");
  const scheme = hasScheme ? `${url.slice(0, url.indexOf("://"))}://` : "";
  const rest = hasScheme ? url.slice(url.indexOf("://") + 3) : url;
  const authMatch = /^[^/?#]*/.exec(rest);
  const authority = authMatch ? authMatch[0] : "";
  const tail = rest.slice(authority.length);
  const userinfo = authority.includes("@") ? `${authority.slice(0, authority.lastIndexOf("@"))}@` : "";
  const hostport = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
  let port = "";
  if (hostport.startsWith("[")) {
    const afterBracket = hostport.slice(hostport.indexOf("]") + 1);
    if (afterBracket.startsWith(":")) port = afterBracket;
  } else if (hostport.includes(":")) {
    port = hostport.slice(hostport.indexOf(":"));
  }
  return `${scheme}${userinfo}${newHost}${port}${tail}`;
}

/** Does the URL's host name this machine's loopback? */
export function urlIsLoopback(url: string): boolean {
  const h = urlHost(url);
  return h === "localhost" || h.startsWith("127.") || h === "0.0.0.0" || h === "::1";
}
