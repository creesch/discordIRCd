import * as net from "net";
import { Logger } from "winston";
import { Promise } from "bluebird";

export class IRCServer {
    constructor(logger: Logger) {
        this.logger = logger;
    }

    private logger: Logger;
    private socket?: net.Socket;
    private clientCount = 0;
    private discordId = "";
    private nickname = "";
    private user = "";
    private pongCount = 0;
    private isCAPBlocked = false;
    private isAuthenticated = false;
    private awayNotify = false;

    private onError(error: Error) {
        this.logger.error(error);

        if (this.socket) this.socket.end();
    }

    private onData(data: any) {
        if (!this.socket) return;

        const dataArray = data.match(/.+/g);
        for (let line of dataArray) {
            const parsedLine = this.parseMessage(line);
            if (parsedLine.command === "CAP" && parsedLine.params) {
                const capSubCommand = parsedLine.params[0];
                const nickname = this.nickname || "*";

                switch (capSubCommand) {
                    case "LS":
                        this.isCAPBlocked = true;
                        this.socket.write(`:${configuration.ircServer.hostname} CAP ${nickname} LS :away-notify\r\n`);
                        break;
                    default:
                        break;
                }
            }
        }
    }

    private setEvents() {
        if (!this.socket) {
            throw new Error("No socket... What");
        }

        this.socket.on("error", this.onError);
        this.socket.on("data", this.onData);
    }

    public createServer(options: NetOptions) {
        return new Promise(resolve => {
            net.createServer(options, async socket => {
                this.socket = socket;
                resolve(this.socket);
            });
        });
    }

    // Function that parses irc messages.
    // Shamelessly stolen from node-irc https://github.com/aredridel/node-ircd
    // Altered because I had to fight Typescript a bit :(
    private parseMessage(line: string): IrcMessage {
        const message: IrcMessage = {
            params: [],
            sender: "",
            command: "",
            error: undefined,
        };
        let m = /(:[^ ]+ )?([A-Z0-9]+)(?: (.*))?/i.exec(line);
        if (!m) {
            message["error"] = "Unable to parse message";
            return message;
        } else {
            let i;
            if (m[3] && (i = m[3].indexOf(':')) !== -1) {
                let rest = m[3].slice(i + 1);
                message.params = m[3].slice(0, i - 1).split(' ');
                message.params.push(rest);
            } else {
                if (m[3]) {
                    message.params = m[3].split(' ');
                } else {
                    message.params = [];
                }
            }
            if (m[2]) {
                message.command = m[2].toUpperCase();
            }
            if (m[1]) {
                message.sender = m[1];
            }

            return message;
        }
    }
}

interface NetOptions {
    allowHalfOpen?: boolean;
    pauseOnConnect?: boolean;
}

interface IrcMessage {
    command?: string;
    params?: string[];
    sender?: string;
    error?: string;
}
