import * as net from "net";
import { Logger } from "winston";
import { promisify } from "util";
import SocketEx from "../util/SocketEx";

export class IRCServer {
    constructor(logger: Logger) {
        this.logger = logger;
    }

    private logger: Logger;
    private socketEx?: SocketEx;
    private clientCount = 0;
    private discordId = "";
    private nickname = "";
    private user = "";
    private pongCount = 0;
    private isCAPBlocked = false;
    private isAuthenticated = false;
    private awayNotify = false;

    private async onError(error: Error) {
        this.logger.error(error);

        if (this.socketEx) {
            // The first two arguments for some reason aren't marked as optional in node's typings :(
            // @ts-ignore
            await this.socketEx.endPromise();
        }
    }

    private async onData(data: any) {
        if (!this.socketEx) return;

        const dataArray = data.match(/.+/g);
        for (let line of dataArray) {
            const parsedLine = this.parseMessage(line);
            if (parsedLine.command === "CAP" && parsedLine.params) {
                const capSubCommand = parsedLine.params[0];
                const nickname = this.nickname || "*";

                switch (capSubCommand) {
                    case "LS":
                        this.isCAPBlocked = true;
                        await this.socketEx.writePromise(`:${configuration.ircServer.hostname} CAP ${nickname} LS :away-notify\r\n`);
                        break;
                    case "LIST":
                        await this.socketEx.writePromise(`:${configuration.ircServer.hostname} CAP ${nickname} LIST :away-notify\r\n`);
                        break;
                    default:
                        // We have no idea what we are dealing with. Inform the client.
                        await this.socketEx.writePromise(`:${configuration.ircServer.hostname} 410 * ${capSubCommand} :Invalid CAP command\r\n`);
                        break;
                }
            }
        }
    }

    private setEvents() {
        if (!this.socketEx) {
            // This is mostly here for
            throw new Error("No socket... What");
        }

        this.socketEx.socket.on("error", this.onError);
        this.socketEx.socket.on("data", this.onData);
    }

    public createServer(options: NetOptions) {
        return new Promise(resolve => {
            net.createServer(options, async socket => {
                this.socketEx = new SocketEx(socket);
                resolve(this.socketEx);
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

