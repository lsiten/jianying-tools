# Cloudflare 信令 Worker

该 Worker 转发同一 WebRTC 会话中的 SDP、ICE candidate 和关闭事件，并代理经本机 HMAC 认证的短期 TURN 凭据请求。它不接收、缓存或持久化任何素材字节；长期 TURN Token 仅作为 Worker Secret 保存，手机只收到短期 ICE 凭据。

## 部署前置条件

1. 使用 `pnpm --filter @jianying/signaling-worker exec wrangler whoami` 确认 Wrangler CLI 已认证。浏览器登录 Cloudflare 控制台不会自动认证 CLI。
2. 在 Cloudflare Worker 中设置与本机服务一致的高熵 `SIGNALING_HMAC_SECRET`：

   ```sh
   pnpm --filter @jianying/signaling-worker exec wrangler secret put SIGNALING_HMAC_SECRET
   ```

3. 只在当前项目目录运行部署：

   ```sh
   pnpm --filter @jianying/signaling-worker exec wrangler deploy
   ```

4. 如需支持受限网络下的 WebRTC TURN 中继，将 Cloudflare Dashboard 创建的 TURN 值仅写入 Worker Secret：

   ```sh
   pnpm --filter @jianying/signaling-worker exec wrangler secret put TURN_API_TOKEN
   pnpm --filter @jianying/signaling-worker exec wrangler secret put TURN_KEY_ID
   ```

   本机 Server 不保存这些长期值。它以已有信令 HMAC 请求 `/v1/turn/<nodeId>`，Worker 代为调用 Cloudflare
   `generate-ice-servers` 并返回会话级短期 ICE 用户名/密码。

## 验证

部署前可在不创建远端资源的情况下编译检查：

```sh
pnpm --filter @jianying/signaling-worker exec wrangler deploy --dry-run
```

如果本机遗留了 Wrangler 不支持的 SOCKS 代理变量，临时清除该进程的 `HTTP_PROXY`、`HTTPS_PROXY` 与 `ALL_PROXY` 后再运行命令；不要把密钥写入 `.dev.vars`、Git 或日志。
