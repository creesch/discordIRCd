import * as net from "net";
import { Logger } from "winston";
import SocketEx from "../util/SocketEx";
import { parseMessage } from "../util/parseMessage";
import { NetOptions } from "../types";

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
            const parsedLine = parseMessage(line);
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

}
