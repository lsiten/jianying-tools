import type { Dispatcher } from "undici";
import { Agent, EnvHttpProxyAgent, Socks5ProxyAgent, WebSocket } from "undici";

type SystemProxyEnvironment = {
  readonly httpProxy: string | undefined;
  readonly httpsProxy: string | undefined;
  readonly noProxy: string | undefined;
};

/** Opens a Node WebSocket using the standard HTTP(S)_PROXY and NO_PROXY policy. */
export function createSystemProxyWebSocket(url: string): WebSocket {
  const destination = new URL(url);
  return new WebSocket(url, {
    dispatcher: selectDispatcher(destination, systemProxyEnvironment()),
  });
}

const directDispatcher = new Agent();
const dispatcherByProxy = new Map<string, Dispatcher>();

function selectDispatcher(
  destination: URL,
  environment: SystemProxyEnvironment,
): Dispatcher {
  const proxy = configuredProxy(destination, environment);
  if (proxy === undefined || bypassesProxy(destination, environment.noProxy)) {
    return directDispatcher;
  }
  const cached = dispatcherByProxy.get(proxy);
  if (cached !== undefined) {
    return cached;
  }
  const dispatcher = createProxyDispatcher(proxy);
  dispatcherByProxy.set(proxy, dispatcher);
  return dispatcher;
}

function configuredProxy(
  destination: URL,
  environment: SystemProxyEnvironment,
): string | undefined {
  return destination.protocol === "https:" || destination.protocol === "wss:"
    ? (environment.httpsProxy ?? environment.httpProxy)
    : environment.httpProxy;
}

function createProxyDispatcher(proxy: string): Dispatcher {
  const proxyUrl = new URL(proxy);
  if (proxyUrl.protocol === "socks5h:") {
    proxyUrl.protocol = "socks5:";
  }
  if (proxyUrl.protocol === "socks5:" || proxyUrl.protocol === "socks:") {
    return new Socks5ProxyAgent(proxyUrl);
  }
  if (proxyUrl.protocol === "http:" || proxyUrl.protocol === "https:") {
    return new EnvHttpProxyAgent({
      httpProxy: proxy,
      httpsProxy: proxy,
    });
  }
  throw new TypeError("Unsupported system proxy protocol");
}

function systemProxyEnvironment(): SystemProxyEnvironment {
  return {
    httpProxy:
      systemEnvironmentValue("http_proxy") ??
      systemEnvironmentValue("HTTP_PROXY"),
    httpsProxy:
      systemEnvironmentValue("https_proxy") ??
      systemEnvironmentValue("HTTPS_PROXY"),
    noProxy:
      systemEnvironmentValue("no_proxy") ?? systemEnvironmentValue("NO_PROXY"),
  };
}

function systemEnvironmentValue(name: string): string | undefined {
  return process.env[name];
}

function bypassesProxy(destination: URL, noProxy: string | undefined): boolean {
  if (noProxy === undefined || noProxy.trim() === "") {
    return false;
  }
  if (noProxy.trim() === "*") {
    return true;
  }
  const destinationPort = Number.parseInt(destination.port, 10);
  const port = Number.isNaN(destinationPort)
    ? destination.protocol === "https:" || destination.protocol === "wss:"
      ? 443
      : 80
    : destinationPort;
  return noProxy.split(/[\s,]+/).some((entry) => {
    const [hostname, configuredPort] = entry
      .replace(/^\*?\./, "")
      .toLowerCase()
      .split(":");
    if (hostname === undefined || hostname === "") {
      return false;
    }
    if (configuredPort !== undefined && Number(configuredPort) !== port) {
      return false;
    }
    const destinationHost = destination.hostname.toLowerCase();
    return (
      destinationHost === hostname || destinationHost.endsWith(`.${hostname}`)
    );
  });
}
