/*
 * terno-mcp: the command agents run to reach Terno (plan 293, CASA 6.2.1).
 *
 * The MCP server lives in the running app (its backend: packages/mcp's serveMcp). This program only carries the
 * agent's newline-delimited JSON-RPC between its stdin/stdout and the app's agent socket: it reads the per-start
 * token from its 0600 file, sends it as the first line, then copies whole lines both ways. No Node, no Electron,
 * nothing it loads or runs.
 *
 * While Terno can't be reached (closed, agents off, or it quit mid-session) it answers as the server did offline,
 * from the manifest compiled in at packaging (mcp-offline.h: the server's own initialize result and tools/list):
 * initialize, tools/list and ping succeed; a tool call gets the "Can't reach Terno" error as a tool result; any other
 * request is "method not found"; notifications are dropped. Every request tries the socket again first, and on a new
 * connection the agent's initialize is replayed to the app (its answer swallowed), so a session started before
 * Terno opened works once it does. Requests in flight when the connection drops are answered as offline.
 *
 * Messages are read with a small top-level scanner: it finds a line's "id", "method" and "params" without decoding
 * them; what the bridge writes itself is a fixed template around the request's raw id.
 */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <poll.h>
#ifdef __APPLE__
#include <pwd.h>
#endif
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <fcntl.h>
#include <time.h>
#include <unistd.h>

#include "mcp-offline.h"

/* the id of the initialize the bridge replays on a new connection; its answer never reaches the agent */
#define REPLAY_ID "\"terno-mcp-bridge-initialize\""
/* One message from the agent: the in-app server reads at most this much of one (its transport's bound, serve.ts's
   AGENT_FRAME_MAX); past it the agent's stream is broken. The app's answers (an attachment's page, an image) may be
   larger, up to MAX_ANSWER. */
#define MAX_REQUEST ((size_t)16 << 20)
#define MAX_ANSWER ((size_t)256 << 20)
#define HANDSHAKE_MS 5000

typedef struct {
  char *data;
  size_t len, cap;
} buf_t;

typedef struct {
  const char *p;
  size_t n;
} span_t;

typedef struct {
  span_t id, method, params;
  int object;
} msg_t;

typedef struct {
  char *line; /* the request as the agent wrote it, answered offline if the connection drops */
  size_t len;
  span_t id;
} pending_t;

static char sock_path[4096];
static char token_path[4096];
static int sock = -1;
static buf_t from_agent, from_app;
static pending_t *pending;
static size_t pending_n, pending_cap;
static char *init_params; /* the agent's initialize params, replayed on a new connection */
static size_t init_params_n;
static int initialized;     /* the agent has initialized (online or offline) */
static int replay_pending;  /* the replayed initialize hasn't been answered yet */
static const char *offline_text = NOT_RUNNING_JSON;

/* ───────────────────────────── buffers and I/O ───────────────────────────── */

static void die_oom(void) {
  static const char m[] = "terno-mcp: out of memory\n";
  (void)!write(2, m, sizeof m - 1);
  exit(70);
}

static void buf_append(buf_t *b, const char *p, size_t n) {
  if (b->len + n > b->cap) {
    size_t cap = b->cap ? b->cap : 65536;
    while (cap < b->len + n) cap *= 2;
    char *next = realloc(b->data, cap);
    if (!next) die_oom();
    b->data = next;
    b->cap = cap;
  }
  memcpy(b->data + b->len, p, n);
  b->len += n;
}

static void buf_str(buf_t *b, const char *s) { buf_append(b, s, strlen(s)); }

static void buf_consume(buf_t *b, size_t n) {
  memmove(b->data, b->data + n, b->len - n);
  b->len -= n;
}

static int write_all(int fd, const char *p, size_t n) {
  while (n) {
    ssize_t w = write(fd, p, n);
    if (w < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    p += w;
    n -= (size_t)w;
  }
  return 0;
}

static void to_agent(const char *p, size_t n) {
  /* the agent went away: nothing left to do */
  if (write_all(1, p, n) || write_all(1, "\n", 1)) exit(0);
}

/* ───────────────────────────── the scanner ───────────────────────────── */

static const char *skip_ws(const char *p, const char *end) {
  while (p < end && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) p++;
  return p;
}

/* p at an opening quote; returns just past the closing one, or NULL */
static const char *skip_string(const char *p, const char *end) {
  for (p++; p < end; p++) {
    if (*p == '\\') p++;
    else if (*p == '"') return p + 1;
  }
  return NULL;
}

static const char *skip_value(const char *p, const char *end) {
  if (p >= end) return NULL;
  if (*p == '"') return skip_string(p, end);
  if (*p == '{' || *p == '[') {
    int depth = 0;
    while (p < end) {
      if (*p == '"') {
        p = skip_string(p, end);
        if (!p) return NULL;
        continue;
      }
      if (*p == '{' || *p == '[') depth++;
      else if ((*p == '}' || *p == ']') && --depth == 0) return p + 1;
      p++;
    }
    return NULL;
  }
  const char *start = p;
  while (p < end && *p != ',' && *p != '}' && *p != ']' && *p != ' ' && *p != '\t' && *p != '\r' && *p != '\n') p++;
  return p > start ? p : NULL;
}

static int key_is(const char *k, size_t n, const char *want) { return n == strlen(want) && memcmp(k, want, n) == 0; }

/* The members `keys` of the top-level object in p[0..n), each as its raw value text; `ok` is 0 unless it's an object. */
static int members(const char *p, size_t n, const char *const *keys, span_t *out, size_t count) {
  const char *end = p + n;
  for (size_t i = 0; i < count; i++) out[i] = (span_t){0, 0};
  p = skip_ws(p, end);
  if (p >= end || *p != '{') return 0;
  p = skip_ws(p + 1, end);
  if (p < end && *p == '}') return 1;
  while (p < end) {
    if (*p != '"') return 0;
    const char *k = p + 1;
    const char *ke = skip_string(p, end);
    if (!ke) return 0;
    size_t kn = (size_t)(ke - 1 - k);
    p = skip_ws(ke, end);
    if (p >= end || *p != ':') return 0;
    p = skip_ws(p + 1, end);
    const char *v = p;
    p = skip_value(p, end);
    if (!p) return 0;
    for (size_t i = 0; i < count; i++)
      if (key_is(k, kn, keys[i])) out[i] = (span_t){v, (size_t)(p - v)};
    p = skip_ws(p, end);
    if (p < end && *p == ',') {
      p = skip_ws(p + 1, end);
      continue;
    }
    return p < end && *p == '}';
  }
  return 0;
}

static msg_t scan(const char *p, size_t n) {
  static const char *const keys[] = {"id", "method", "params"};
  span_t s[3];
  msg_t m = {{0, 0}, {0, 0}, {0, 0}, 0};
  if (!members(p, n, keys, s, 3)) return m;
  m.id = s[0];
  m.method = s[1];
  m.params = s[2];
  m.object = 1;
  return m;
}

static int span_is(span_t s, const char *literal) { return s.p && key_is(s.p, s.n, literal); }

static int span_eq(span_t a, span_t b) { return a.n == b.n && a.p && b.p && memcmp(a.p, b.p, a.n) == 0; }

static int hex4(const char *p, const char *end, unsigned *out) {
  unsigned v = 0;
  if (end - p < 4) return 0;
  for (int i = 0; i < 4; i++) {
    char c = p[i];
    v <<= 4;
    if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
    else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
    else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
    else return 0;
  }
  *out = v;
  return 1;
}

static void put_utf8(buf_t *b, unsigned cp) {
  char u[4];
  size_t n;
  if (cp < 0x80) u[0] = (char)cp, n = 1;
  else if (cp < 0x800) u[0] = (char)(0xC0 | cp >> 6), u[1] = (char)(0x80 | (cp & 0x3F)), n = 2;
  else if (cp < 0x10000) u[0] = (char)(0xE0 | cp >> 12), u[1] = (char)(0x80 | (cp >> 6 & 0x3F)), u[2] = (char)(0x80 | (cp & 0x3F)), n = 3;
  else u[0] = (char)(0xF0 | cp >> 18), u[1] = (char)(0x80 | (cp >> 12 & 0x3F)), u[2] = (char)(0x80 | (cp >> 6 & 0x3F)), u[3] = (char)(0x80 | (cp & 0x3F)), n = 4;
  buf_append(b, u, n);
}

/* a JSON string's content as UTF-8, escapes decoded; 0 when it's malformed */
static int decode_string(span_t s, buf_t *out) {
  const char *p = s.p + 1, *end = s.p + s.n - 1;
  while (p < end) {
    if (*p != '\\') {
      buf_append(out, p++, 1);
      continue;
    }
    if (++p >= end) return 0;
    char c = *p++;
    unsigned cp;
    switch (c) {
      case 'b': put_utf8(out, '\b'); break;
      case 'f': put_utf8(out, '\f'); break;
      case 'n': put_utf8(out, '\n'); break;
      case 'r': put_utf8(out, '\r'); break;
      case 't': put_utf8(out, '\t'); break;
      case 'u':
        if (!hex4(p, end, &cp)) return 0;
        p += 4;
        if (cp >= 0xD800 && cp < 0xDC00 && end - p >= 6 && p[0] == '\\' && p[1] == 'u') {
          unsigned lo;
          if (hex4(p + 2, end, &lo) && lo >= 0xDC00 && lo < 0xE000) {
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            p += 6;
          }
        }
        put_utf8(out, cp);
        break;
      default: buf_append(out, &c, 1);
    }
  }
  return 1;
}

/* Two request ids are the same id: strings by their decoded content, numbers by value (the app writes back
   JSON.stringify(id), so `"a\/b"` comes back as `"a/b"` and `1.0` as `1`). */
static int id_eq(span_t a, span_t b) {
  if (span_eq(a, b)) return 1;
  if (!a.p || !b.p || !a.n || !b.n) return 0;
  if (*a.p == '"' && *b.p == '"') {
    buf_t x = {0, 0, 0}, y = {0, 0, 0};
    int same = decode_string(a, &x) && decode_string(b, &y) && x.len == y.len && (x.len == 0 || memcmp(x.data, y.data, x.len) == 0);
    free(x.data);
    free(y.data);
    return same;
  }
  if (*a.p == '"' || *b.p == '"' || a.n > 63 || b.n > 63) return 0;
  char x[64], y[64], *ex, *ey;
  memcpy(x, a.p, a.n), x[a.n] = 0;
  memcpy(y, b.p, b.n), y[b.n] = 0;
  double dx = strtod(x, &ex), dy = strtod(y, &ey);
  return *ex == 0 && *ey == 0 && dx == dy;
}

/* a request: a method and an id that isn't null */
static int is_request(msg_t m) { return m.object && m.method.p && m.id.p && !span_is(m.id, "null"); }

/* ───────────────────────────── offline answers ───────────────────────────── */

static void reply(span_t id, const char *kind, const char *body) {
  buf_t b = {0, 0, 0};
  buf_str(&b, "{\"jsonrpc\":\"2.0\",\"id\":");
  buf_append(&b, id.p, id.n);
  buf_str(&b, ",\"");
  buf_str(&b, kind);
  buf_str(&b, "\":");
  buf_str(&b, body);
  buf_str(&b, "}");
  to_agent(b.data, b.len);
  free(b.data);
}

/* the protocol version the SDK's server would answer: the client's when it's one it supports, else the latest */
static const char *negotiated(span_t params) {
  static const char *const keys[] = {"protocolVersion"};
  span_t v;
  if (params.p && members(params.p, params.n, keys, &v, 1) && v.p) {
    for (size_t i = 0; i < sizeof SUPPORTED_VERSIONS / sizeof *SUPPORTED_VERSIONS; i++)
      if (span_is(v, SUPPORTED_VERSIONS[i])) return SUPPORTED_VERSIONS[i];
  }
  return LATEST_VERSION;
}

/* answers one request as the server did while Terno couldn't be reached; `lost`: it was sent, and the connection
   dropped before its answer, so a tool call's outcome is unknown */
static void answer_offline(const char *line, size_t n, int lost) {
  msg_t m = scan(line, n);
  if (!is_request(m)) return;
  if (span_is(m.method, "\"initialize\"")) {
    buf_t b = {0, 0, 0};
    buf_str(&b, "{\"protocolVersion\":");
    buf_str(&b, negotiated(m.params));
    buf_str(&b, ",");
    buf_str(&b, INITIALIZE_REST);
    buf_str(&b, "}");
    buf_append(&b, "", 1);
    reply(m.id, "result", b.data);
    free(b.data);
  } else if (span_is(m.method, "\"tools/list\"")) {
    reply(m.id, "result", TOOLS_LIST_JSON);
  } else if (span_is(m.method, "\"ping\"")) {
    reply(m.id, "result", "{}");
  } else if (span_is(m.method, "\"tools/call\"")) {
    buf_t b = {0, 0, 0};
    buf_str(&b, "{\"content\":[{\"type\":\"text\",\"text\":");
    buf_str(&b, lost ? LOST_JSON : offline_text);
    buf_str(&b, "}],\"isError\":true}");
    buf_append(&b, "", 1);
    reply(m.id, "result", b.data);
    free(b.data);
  } else {
    reply(m.id, "error", "{\"code\":-32601,\"message\":\"Method not found\"}");
  }
}

/* ───────────────────────────── requests in flight ───────────────────────────── */

static void pending_add(const char *line, size_t n, span_t id) {
  if (pending_n == pending_cap) {
    size_t cap = pending_cap ? pending_cap * 2 : 16;
    pending_t *next = realloc(pending, cap * sizeof *next);
    if (!next) die_oom();
    pending = next;
    pending_cap = cap;
  }
  char *copy = malloc(n ? n : 1);
  if (!copy) die_oom();
  memcpy(copy, line, n);
  pending[pending_n++] = (pending_t){copy, n, {copy + (id.p - line), id.n}};
}

static void pending_settle(span_t id) {
  for (size_t i = 0; i < pending_n; i++) {
    if (!id_eq(pending[i].id, id)) continue;
    free(pending[i].line);
    pending[i] = pending[--pending_n];
    return;
  }
}

/* ───────────────────────────── the connection ───────────────────────────── */

/* dst = a + b + c, or "" when it wouldn't fit (an unusable path: Terno then reads as not running) */
static void join3(char *dst, size_t size, const char *a, const char *b, const char *c) {
  size_t na = strlen(a), nb = strlen(b), nc = strlen(c);
  dst[0] = 0;
  if (na + nb + nc + 1 > size) return;
  memcpy(dst, a, na);
  memcpy(dst + na, b, nb);
  memcpy(dst + na + nb, c, nc + 1);
}

static void resolve_paths(void) {
  const char *s = getenv("TERNO_SOCKET"), *t = getenv("TERNO_TOKEN_FILE"), *u = getenv("TERNO_USER_DATA");
  char profile[4096];
  if (u && *u) {
    join3(profile, sizeof profile, u, "", "");
  } else {
    const char *home = getenv("HOME");
#ifdef __APPLE__
    if (!home || !*home) {
      struct passwd *pw = getpwuid(getuid());
      home = pw && pw->pw_dir ? pw->pw_dir : "";
    }
#else
    /* the Linux bridge is static, and glibc's getpwuid needs its shared NSS modules at run time: HOME it is */
    if (!home) home = "";
#endif
#ifdef __APPLE__
    join3(profile, sizeof profile, home, "/Library/Application Support/Terno", "");
#else
    const char *xdg = getenv("XDG_CONFIG_HOME");
    if (xdg && *xdg) join3(profile, sizeof profile, xdg, "/Terno", "");
    else join3(profile, sizeof profile, home, "/.config/Terno", "");
#endif
  }
  if (s && *s) join3(sock_path, sizeof sock_path, s, "", "");
  else if (*profile) join3(sock_path, sizeof sock_path, profile, "/agent.sock", "");
  if (t && *t) join3(token_path, sizeof token_path, t, "", "");
  else if (*profile) join3(token_path, sizeof token_path, profile, "/agent.token", "");
}

static long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void drop_connection(void) {
  if (sock >= 0) close(sock);
  sock = -1;
  from_app.len = 0;
  replay_pending = 0;
}

/* Connects, sends the token and waits for the app's {"ok":true}; returns 0 when connected. */
static int try_connect(void) {
  char token[512];
  int fd = open(token_path, O_RDONLY);
  offline_text = NOT_RUNNING_JSON;
  if (fd < 0) return -1;
  ssize_t r = read(fd, token, sizeof token - 1);
  close(fd);
  if (r <= 0) return -1;
  size_t tn = (size_t)r;
  while (tn && (token[tn - 1] == '\n' || token[tn - 1] == '\r' || token[tn - 1] == ' ' || token[tn - 1] == '\t')) tn--;
  if (!tn) return -1;
  token[tn++] = '\n';

  struct sockaddr_un addr;
  memset(&addr, 0, sizeof addr);
  addr.sun_family = AF_UNIX;
  if (strlen(sock_path) >= sizeof addr.sun_path) return -1;
  memcpy(addr.sun_path, sock_path, strlen(sock_path) + 1);
  sock = socket(AF_UNIX, SOCK_STREAM, 0);
  if (sock < 0) return -1;
  if (connect(sock, (struct sockaddr *)&addr, sizeof addr) < 0 || write_all(sock, token, tn)) {
    drop_connection();
    return -1;
  }
  /* the answer to the token, within the handshake's bound */
  long until = now_ms() + HANDSHAKE_MS;
  char chunk[4096];
  for (;;) {
    char *nl = from_app.len ? memchr(from_app.data, '\n', from_app.len) : NULL;
    if (nl) {
      size_t n = (size_t)(nl - from_app.data);
      int ok = n >= 11 && memcmp(from_app.data, "{\"ok\":true}", 11) == 0;
      buf_consume(&from_app, n + 1);
      if (ok) return 0;
      offline_text = REJECTED_JSON;
      drop_connection();
      return -1;
    }
    long left = until - now_ms();
    struct pollfd pfd = {sock, POLLIN, 0};
    int ready = left > 0 ? poll(&pfd, 1, (int)left) : 0;
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0) {
      drop_connection();
      return -1;
    }
    ssize_t got = read(sock, chunk, sizeof chunk);
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0 || from_app.len + (size_t)got > 1024) {
      drop_connection();
      return -1;
    }
    buf_append(&from_app, chunk, (size_t)got);
  }
}

static int to_app(const char *p, size_t n) { return write_all(sock, p, n) || write_all(sock, "\n", 1) ? -1 : 0; }

/* the agent's session, carried to a new connection: its initialize (or a minimal one) and initialized */
static int replay_initialize(void) {
  buf_t b = {0, 0, 0};
  buf_str(&b, "{\"jsonrpc\":\"2.0\",\"id\":" REPLAY_ID ",\"method\":\"initialize\",\"params\":");
  if (init_params) buf_append(&b, init_params, init_params_n);
  else buf_str(&b, "{\"protocolVersion\":" LATEST_VERSION ",\"capabilities\":{},\"clientInfo\":{\"name\":\"terno-mcp\",\"version\":\"1\"}}");
  buf_str(&b, "}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}");
  int failed = to_app(b.data, b.len);
  free(b.data);
  replay_pending = !failed;
  return failed;
}

/* The connection is gone: every request it held is answered as offline. */
static void connection_lost(void) {
  drop_connection();
  for (size_t i = 0; i < pending_n; i++) {
    answer_offline(pending[i].line, pending[i].len, 1);
    free(pending[i].line);
  }
  pending_n = 0;
}

/* ───────────────────────────── the two directions ───────────────────────────── */

static void from_agent_line(const char *line, size_t n) {
  msg_t m = scan(line, n);
  int request = is_request(m);
  int init = request && span_is(m.method, "\"initialize\"");
  if (init) {
    free(init_params);
    init_params = NULL;
    init_params_n = 0;
    if (m.params.p) {
      init_params = malloc(m.params.n);
      if (!init_params) die_oom();
      memcpy(init_params, m.params.p, m.params.n);
      init_params_n = m.params.n;
    }
  }
  if (sock < 0 && request && try_connect() == 0 && !init && initialized && replay_initialize()) connection_lost();
  if (init) initialized = 1;
  if (sock < 0) {
    if (request) answer_offline(line, n, 0);
    return;
  }
  if (request) pending_add(line, n, m.id);
  else if (span_is(m.method, "\"notifications/cancelled\"") && m.params.p) {
    /* the app won't answer a cancelled request: it's no longer in flight */
    static const char *const keys[] = {"requestId"};
    span_t id;
    if (members(m.params.p, m.params.n, keys, &id, 1) && id.p) pending_settle(id);
  }
  if (to_app(line, n)) connection_lost();
}

static void from_app_line(const char *line, size_t n) {
  msg_t m = scan(line, n);
  if (m.object && m.id.p && !m.method.p) {
    if (replay_pending && span_is(m.id, REPLAY_ID)) {
      replay_pending = 0;
      return;
    }
    pending_settle(m.id);
  }
  to_agent(line, n);
}

/* Hands every whole line in `b` to `each`; `last` also hands over what's left (the stream ended). */
static void lines(buf_t *b, void (*each)(const char *, size_t), int last, size_t max) {
  size_t start = 0;
  for (;;) {
    char *nl = memchr(b->data + start, '\n', b->len - start);
    if (!nl) break;
    size_t n = (size_t)(nl - (b->data + start));
    if (n && b->data[start + n - 1] == '\r') n--;
    if (n) each(b->data + start, n);
    start = (size_t)(nl - b->data) + 1;
  }
  buf_consume(b, start);
  if (last && b->len) {
    each(b->data, b->len);
    b->len = 0;
  }
  if (b->len > max) {
    static const char m[] = "terno-mcp: a message is too large\n";
    (void)!write(2, m, sizeof m - 1);
    exit(1);
  }
}

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  resolve_paths();
  int agent_open = 1;
  char chunk[65536];
  for (;;) {
    struct pollfd fds[2];
    nfds_t n = 0;
    int ia = -1, is = -1;
    if (agent_open) {
      ia = (int)n;
      fds[n++] = (struct pollfd){0, POLLIN, 0};
    }
    if (sock >= 0) {
      is = (int)n;
      fds[n++] = (struct pollfd){sock, POLLIN, 0};
    }
    if (!n) break;
    if (poll(fds, n, -1) < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (is >= 0 && (fds[is].revents & (POLLIN | POLLHUP | POLLERR))) {
      ssize_t r = read(sock, chunk, sizeof chunk);
      if (r > 0) {
        buf_append(&from_app, chunk, (size_t)r);
        lines(&from_app, from_app_line, 0, MAX_ANSWER);
      } else if (!(r < 0 && errno == EINTR)) {
        /* an answer cut off by the drop is no answer: its request is answered as lost, below (never half a line) */
        connection_lost();
      }
    }
    if (ia >= 0 && (fds[ia].revents & (POLLIN | POLLHUP | POLLERR))) {
      ssize_t r = read(0, chunk, sizeof chunk);
      if (r > 0) {
        buf_append(&from_agent, chunk, (size_t)r);
        lines(&from_agent, from_agent_line, 0, MAX_REQUEST);
      } else if (!(r < 0 && errno == EINTR)) {
        lines(&from_agent, from_agent_line, 1, MAX_REQUEST);
        agent_open = 0;
        /* the agent is done: the app finishes what's in flight and closes */
        if (sock >= 0) shutdown(sock, SHUT_WR);
      }
    }
  }
  return 0;
}
