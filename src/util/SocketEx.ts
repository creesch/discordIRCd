import net from "net";
import { promisify } from "util";

export default class SocketEx {
    constructor(socket: net.Socket) {
        this.socket = socket;
    }

    public socket: net.Socket;
    public writePromise = promisify(this.socket.write);
    public endPromise = promisify(this.socket.end);
    public setTimeoutPromise = promisify(this.socket.setTimeout);
}
