declare module 'express' {
    import type { Server } from 'node:http';

    export type NextFunction = (error?: unknown) => void;

    export interface Request {
        adminToken?: string;
        body: any;
        connection?: { remoteAddress?: string | null };
        currentUser: Record<string, any>;
        get: (name: string) => string | undefined;
        header: (name: string) => string | undefined;
        headers: Record<string, string | string[] | undefined>;
        ip?: string;
        method: string;
        params: Record<string, string>;
        path: string;
        query: Record<string, any>;
        socket: { remoteAddress?: string | null };
    }

    export interface Response {
        headersSent: boolean;
        end: (body?: unknown) => Response;
        header: (name: string, value: string) => Response;
        json: (body: unknown) => Response;
        redirect: (path: string) => Response;
        send: (body?: unknown) => Response;
        sendFile: (path: string) => Response;
        sendStatus: (status: number) => Response;
        set: (name: string, value: string | number) => Response;
        setHeader: (name: string, value: string | number | readonly string[]) => void;
        status: (status: number) => Response;
    }

    export type RequestHandler = (request: Request, response: Response, next: NextFunction) => unknown;

    export interface Express {
        delete: (path: string, ...handlers: RequestHandler[]) => Express;
        get: (path: string, ...handlers: RequestHandler[]) => Express;
        listen: (port: number, host: string, callback?: () => void) => Server;
        post: (path: string, ...handlers: RequestHandler[]) => Express;
        put: (path: string, ...handlers: RequestHandler[]) => Express;
        set: (name: string, value: unknown) => Express;
        use: ((...handlers: RequestHandler[]) => Express) & ((path: string, ...handlers: RequestHandler[]) => Express);
    }

    interface ExpressFactory {
        (): Express;
        json: () => RequestHandler;
        static: (path: string, options?: {
            immutable?: boolean;
            maxAge?: string | number;
            setHeaders?: (response: Response, filePath: string) => void;
        }) => RequestHandler;
    }

    const express: ExpressFactory;
    export default express;
}
