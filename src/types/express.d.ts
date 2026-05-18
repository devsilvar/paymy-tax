declare module 'express-serve-static-core' {
  interface Request {
    query: Record<string, string>;
  }
}