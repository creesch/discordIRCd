export interface IrcMessage {
    command?: string;
    params?: string[];
    sender?: string;
    error?: string;
}

export interface NetOptions {
    allowHalfOpen?: boolean;
    pauseOnConnect?: boolean;
}
