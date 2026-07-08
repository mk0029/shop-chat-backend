import type { Request, Response, NextFunction } from "express";

const SQL_INJECTION_PATTERNS = [
  /(\b(union\s+all\s+)?select\b.+?\bfrom\b)/i,
  /(\binsert\s+into\b.*?\bvalues\b)/i,
  /(\bupdate\s+\w+\s+set\b)/i,
  /(\bdelete\s+from\b)/i,
  /(\bdrop\s+table\b)/i,
  /(\bdrop\s+database\b)/i,
  /(\balter\s+table\b)/i,
  /(\bcreate\s+table\b)/i,
  /(\btruncate\s+table\b)/i,
  /(\bexec\b.*?\()/i,
  /(\bxp_cmdshell\b)/i,
  /(\bsp_executesql\b)/i,
  /(\bpg_sleep\b)/i,
  /(\bwaitfor\s+delay\b)/i,
  /(\bbenchmark\s*\()/i,
  /('?\s*(or|and)\s+['"]?\d+['"]?\s*=\s*['"]?\d+['"]?\s*(--|#|$))/i,
  /(\bunion\s+.*?select\b)/i,
  /(information_schema)/i,
  /(\b(load_file|into\s+outfile|into\s+dumpfile)\b)/i,
];

const XSS_PATTERNS = [
  /<script\b[^>]*>.*?<\/script\b[^>]*>/is,
  /javascript\s*:/i,
  /on\w+\s*=\s*['"]?[^'"]*['"]?/i,
  /onerror\s*=/i,
  /onload\s*=/i,
  /onclick\s*=/i,
  /expression\s*\(/i,
  /<iframe\b/i,
  /<embed\b/i,
  /<object\b/i,
  /<svg\b/i,
  /document\.(write|cookie|domain|location)/i,
  /window\.(location|name|status)/i,
  /eval\s*\(/i,
  /String\.fromCharCode/i,
  /vbscript\s*:/i,
];

const COMMAND_INJECTION_PATTERNS = [
  /[;&|]\s*(rm|del|rd|mdkir|mkdir|chmod|chown|wget|curl|bash|sh|cmd|powershell|python|perl|php|node)\s/i,
  /[`$][({]/,
  /\$\(.*?\)/,
  /`.*?`/,
  /;\s*(rm|del|rd|shutdown|reboot|format|mkfs|dd)\s/i,
  /\/etc\/(passwd|shadow|hosts|sudoers|crontab)/i,
];

const PATH_TRAVERSAL_PATTERNS = [
  /\.\.\/\.\.\//,
  /\.\.\\\.\.\\/,
  /\.\.%2f\.\./i,
  /\.\.%5c\.\./i,
  /%2e%2e%2f/i,
  /\.\.[/\\]/,
  /\.\.\//,
  /\.\.\\/,
];

const RCE_PATTERNS = [
  /(require|import)\s*\(/i,
  /process\s*\.\s*(env|argv|exit|kill|chdir|cwd|umask|exec)/i,
  /Function\s*\(/i,
  /new\s+Function\s*\(/i,
  /child_process/i,
  /fs\.(readFile|writeFile|unlink|exec|spawn)/i,
  /__proto__\s*[.=]/i,
  /constructor\s*\.\s*constructor/i,
];

const MALICIOUS_USER_AGENTS = [
  /sqlmap/i, /nmap/i, /nikto/i, /acunetix/i, /nessus/i,
  /openvas/i, /netsparker/i, /burpsuite/i, /wpscan/i,
  /dirbuster/i, /gobuster/i, /wfuzz/i, /zap\s*proxy/i,
  /python-requests/i, /python-urllib/i, /go-http-client/i,
  /curl\//i, /wget\//i, /masscan/i, /hydra/i,
];

const SUSPICIOUS_BOT_PATTERNS = [
  /semrush/i, /ahrefs/i, /majestic/i, /mj12bot/i,
  /screaming\s*frog/i, /site\s*auditor/i,
  /spider/i, /scanner/i, /crawler/i,
];

const MAX_BODY_SIZE = 10 * 1024 * 1024;

function detectThreat(value: string): string | null {
  const checks: Array<{ patterns: RegExp[]; type: string }> = [
    { patterns: SQL_INJECTION_PATTERNS, type: "sql_injection" },
    { patterns: XSS_PATTERNS, type: "xss" },
    { patterns: COMMAND_INJECTION_PATTERNS, type: "command_injection" },
    { patterns: PATH_TRAVERSAL_PATTERNS, type: "path_traversal" },
    { patterns: RCE_PATTERNS, type: "rce" },
  ];
  for (const check of checks) {
    for (const pattern of check.patterns) {
      if (pattern.test(value)) return check.type;
    }
  }
  return null;
}

function detectHeaderThreat(headers: Record<string, string | undefined>): string | null {
  const ua = headers["user-agent"] || "";
  for (const pattern of MALICIOUS_USER_AGENTS) {
    if (pattern.test(ua)) return "malicious_user_agent";
  }
  for (const pattern of SUSPICIOUS_BOT_PATTERNS) {
    if (pattern.test(ua)) return "suspicious_bot";
  }
  const referer = headers["referer"] || "";
  return detectThreat(referer);
}

function logBlock(req: Request, reason: string, status: number) {
  console.warn(JSON.stringify({
    level: "warn",
    event: "firewall_blocked",
    timestamp: new Date().toISOString(),
    ip: req.ip || req.socket.remoteAddress || "unknown",
    method: req.method,
    url: req.originalUrl || req.url,
    reason,
    status,
    ua: (req.headers["user-agent"] || "unknown").slice(0, 200),
  }));
}

export function waf(req: Request, res: Response, next: NextFunction): void {
  const headerThreat = detectHeaderThreat(req.headers as Record<string, string | undefined>);
  if (headerThreat) {
    logBlock(req, `headers:${headerThreat}`, 403);
    res.status(403).json({ message: "Request blocked by security policy" });
    return;
  }

  const query = req.url?.split("?")[1] || "";
  if (query) {
    const threat = detectThreat(query);
    if (threat) {
      logBlock(req, `query:${threat}`, 400);
      res.status(400).json({ message: "Request blocked by security policy" });
      return;
    }
  }

  if (req.query) {
    for (const value of Object.values(req.query)) {
      if (typeof value === "string") {
        const threat = detectThreat(value);
        if (threat) {
          logBlock(req, `query_param:${threat}`, 400);
          res.status(400).json({ message: "Request blocked by security policy" });
          return;
        }
      } else if (Array.isArray(value)) {
        for (const v of value) {
          if (typeof v === "string") {
            const threat = detectThreat(v);
            if (threat) {
              logBlock(req, `query_param:${threat}`, 400);
              res.status(400).json({ message: "Request blocked by security policy" });
              return;
            }
          }
        }
      }
    }
  }

  if (["POST", "PUT", "PATCH"].includes(req.method)) {
    const cl = req.headers["content-length"];
    if (cl) {
      const size = parseInt(String(cl), 10);
      if (size > MAX_BODY_SIZE) {
        logBlock(req, "payload_too_large", 413);
        res.status(413).json({ message: "Request body too large" });
        return;
      }
    }

    if (req.body && typeof req.body === "object") {
      const bodyStr = JSON.stringify(req.body);
      const threat = detectThreat(bodyStr);
      if (threat) {
        logBlock(req, `body:${threat}`, 400);
        res.status(400).json({ message: "Request blocked by security policy" });
        return;
      }
    }
  }

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(self)",
  );

  next();
}
