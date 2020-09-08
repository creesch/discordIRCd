import { IrcMessage } from "../types";

// Returns a number based on the discord server that increases per call.
// Used to make fairly sure nicknames on irc end up being unique after being scrubbed.
// Make nicknames work for irc.
export const ircNickname = (discordDisplayName: string, botuser: boolean, discriminator: string | number) => {
    const replaceRegex = /[^a-zA-Z0-9_\\[\]\{\}\^`\|]/g;
    const shortenRegex = /_+/g;

    if (replaceRegex.test(discordDisplayName)) {

        let newDisplayname = `${discordDisplayName.replace(replaceRegex, '_')}${discriminator}`;
        newDisplayname = newDisplayname.replace(shortenRegex, '_');

        return botuser ? `${newDisplayname}[BOT]` : newDisplayname;

    } else {
        return botuser ? `${discordDisplayName}[BOT]` : discordDisplayName;
    }
}


// Function that parses irc messages.
// Shamelessly stolen from node-irc https://github.com/aredridel/node-ircd
// Altered because I had to fight Typescript a bit :(
export const parseMessage = (line: string): IrcMessage => {
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
