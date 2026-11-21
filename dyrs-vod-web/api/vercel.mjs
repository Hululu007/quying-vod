// Vercel Serverless 入口：复用 server.mjs 的请求处理器
import { requestHandler } from '../server.mjs';

export const config = { maxDuration: 60 };

export default requestHandler;
