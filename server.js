// When false nothing will be logged. 
// Configuration goes here.
require('./config.js');

if (!configuration.DEBUG) {
    console.log = function() {};
}

const net = require('net');
const Discord = require("discord.js");

//
// Let's ready some variables and stuff we will use later on.
//

// Object which will contain channel information.
let ircDetails = { 
    DMserver: {
        lastPRIVMSG: []
    }
};

// Since we want a seperate connection for each discord server we will need to store our sockets. 
let ircClients = [];

// Simply used to give each new socket a unique number. 
let ircClientCount = 0;

// This is used to make sure that if discord reconnects not everything is wiped. 
let discordFirstConnection = true;

// Max line lenght for irc messages. 
const maxLineLength = 510;

//
// Generic functions
//

// Function that parses irc messages. 
// Shamelessly stolen from node-irc https://github.com/aredridel/node-ircd
function parseMessage(line) {
    let message = {};
    let m = /(:[^ ]+ )?([A-Z0-9]+)(?: (.*))?/i.exec(line);
    if (!m) {
        message['error'] = 'Unable to parse message';
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
    }
    return message;
}

// Returns a number based on the discord server that increases per call.
// Used to make fairly sure nicknames on irc end up being unique after being scrubbed. 
// Make nicknames work for irc. 
function ircNickname(discordDisplayName, botuser, discriminator) {
    const replaceRegex = /[^a-zA-Z0-9_\\[\]\{\}\^`\|]/g;
    const shortenRegex = /_{1,}/g;

    if (replaceRegex.test(discordDisplayName)) {
        
        let newDisplayname = `${discordDisplayName.replace(replaceRegex, '_')}${discriminator}`;
        newDisplayname = newDisplayname.replace(shortenRegex, '_');
        
        return botuser ? `${newDisplayname}[BOT]` : newDisplayname;

    } else {
        return botuser ? `${discordDisplayName}[BOT]` : discordDisplayName;
    }


}


// Parses discord lines to make them work better on irc. 
function parseDiscordLine(line, discordID) {
    // Discord markdown parsing the lazy way. Probably fails in a bunch of different ways but at least it is easy. 
    line = line.replace(/\*\*(.*?)\*\*/g, '\x02$1\x0F');
    line = line.replace(/\*(.*?)\*/g, '\x1D$1\x0F');
    line = line.replace(/__(.*?)__/g, '\x1F$1\x0F');
    // With the above regex we might end up with to many end characters. This replaces the, 
    line = line.replace(/\x0F{2,}/g, '\x0F');

    // Now let's replace mentions with names we can recognize. 
    const mentionUserRegex = /(<@!?\d{1,}?>)/g;
    const mentionUserFound = line.match(mentionUserRegex);

    if (mentionUserFound) {
        mentionUserFound.forEach(function(mention) {
            const userID = mention.replace(/<@!?(\d{1,}?)>/, '$1');
            const memberObject = discordClient.guilds.get(discordID).members.get(userID);
            const displayName = memberObject.displayName;
            const isBot = memberObject.user.bot;
            const discriminator = memberObject.user.discriminator;

            const userName = ircNickname(displayName, isBot, discriminator);
            const replaceRegex = new RegExp(mention, 'g');
            if (userName) {
                line = line.replace(replaceRegex, `@${userName}`);
            }
        });
    }

    // Now let's do this again and replace mentions with roles we can recognize. 
    const mentionRoleRegex = /(<@&\d{1,}?>)/g;
    const mentionRoleFound = line.match(mentionRoleRegex);
    if (mentionRoleFound) {
        mentionRoleFound.forEach(function(mention) {
            const roleID = mention.replace(/<@&(\d{1,}?)>/, '$1');
            const roleObject = discordClient.guilds.get(discordID).roles.get(roleID);    

            const replaceRegex = new RegExp(mention, 'g');
            if (roleObject) {
                const name = roleObject.name;
                line = line.replace(replaceRegex, `@${name}`);
            }
        });
    }

    return line;
}

// Parse irc lines to make them work better on discord.
function parseIRCLine(line, discordID, channel) {

    const mentionRegex = /(@.{1,}?\s)/g;
    const mentionFound = line.match(mentionRegex);

    if (mentionFound) {
        mentionFound.forEach(function(mention) {
            const userNickname = mention.replace(/@(.{1,}?)\s/, '$1');

            const userID = ircDetails[discordID][channel].members[userNickname].id;
            const replaceRegex = new RegExp(mention, 'g');
            if (userID) {
                line = line.replace(replaceRegex, `<@!${userID}> `);
            }
        });
    }
    return line;
}

//
// Discord related functionality.
//

// Create our discord client. 
let discordClient = new Discord.Client({
    fetchAllMembers: true,
    sync: true
});

// Log into discord using the token defined in config.js 
discordClient.login(configuration.discordToken);

//
// Various events used for debugging. 
//

// Will log discord debug information.
discordClient.on('debug', function(info) {
    console.log('debug', info);
});

// When debugging we probably want to know about errors as well. 
discordClient.on('error', function(info) {
    console.log('error', info);
    sendGeneralNotice('Discord error.');
});

// Emitted when the Client tries to reconnect after being disconnected.
discordClient.on('reconnecting', function() {
    console.log('reconnecting');
    sendGeneralNotice('Reconnecting to Discord.');
});

// Emitted whenever the client websocket is disconnected.
discordClient.on('disconnect', function(event) {
    console.log('disconnected', event);
    sendGeneralNotice('Discord has been disconnected.');
});

// Emitted for general warnings.
discordClient.on('warn', function(info) {
    console.log('warn', info);
});

// Discord is ready. 
discordClient.on('ready', function() {
    // This is probably not needed, but since sometimes things are weird with discord.
    discordClient.guilds.array().forEach(function(guild) {
        guild.fetchMembers();
        guild.sync();
    });

    console.log(`Logged in as ${discordClient.user.username}!`);


    // Lets grab some basic information we will need eventually. 
    // But only do so if this is the first time connecting. 
    if (discordFirstConnection) {
        discordFirstConnection = false;


        discordClient.channels.array().forEach(function(channel) {
            // Of course only for channels. 
            if (channel.type === 'text') {
                const guildID = channel.guild.id,
                    channelName = channel.name,
                    channelID = channel.id,
                    channelTopic = channel.topic || 'No topic';

                if (!ircDetails.hasOwnProperty(guildID)) {
                    ircDetails[guildID] = {
                        lastPRIVMSG: []
                    };
                }
                ircDetails[guildID][channelName] = {
                    id: channelID,
                    joined: false,
                    topic: channelTopic
                };
            }
        });

        // Now that is done we can start the irc server side of things. 
        ircServer.listen(configuration.ircServer.listenPort);
    } else {
        sendGeneralNotice('Discord connection has been restored.');
    }
});

//
// Acting on events
//

// There are multiple events that indicate a users is no longer on the server. 
// We abuse the irc QUIT: message for this even if people are banned. 
function guildMemberNoMore(guildID, ircDisplayName, noMoreReason) {
    let found = false;
    // First we go over the channels. 
    for (let channel in ircDetails[guildID]) {
        if (ircDetails[guildID].hasOwnProperty(channel) && ircDetails[guildID][channel].joined) {

            let channelMembers = ircDetails[guildID][channel].members;
            // Within the channels we go over the members. 
            if (channelMembers.hasOwnProperty(ircDisplayName)) {
                if (!found) {
                    let memberDetails = ircDetails[guildID][channel].members[ircDisplayName];
                    console.log(`User ${ircDisplayName} quit ${noMoreReason}`);
                    sendToIRC(guildID, `:${ircDisplayName}!${memberDetails.id}@whatever QUIT :${noMoreReason}\r\n`);
                    found = true;
                }
                delete ircDetails[guildID][channel].members[ircDisplayName];
            }
        }
    }
}

function guildMemberCheckChannels(guildID, ircDisplayName, guildMember) {
    // First we go over the channels. 
    for (let channel in ircDetails[guildID]) {
        if (ircDetails[guildID].hasOwnProperty(channel) && ircDetails[guildID][channel].joined) {
            let isInDiscordChannel = false;
            let isCurrentlyInIRC = false;

            let channelDetails = ircDetails[guildID][channel];
            let channelMembers = channelDetails.members;
            let channelID = channelDetails.id;

            //Let's check the discord channel. 
            let discordMemberArray = discordClient.guilds.get(guildID).channels.get(channelID).members.array();
            discordMemberArray.forEach(function(discordMember) {
                if (guildMember.displayName === discordMember.displayName && (guildMember.presence.status !== 'offline' || configuration.showOfflineUsers)) {
                    isInDiscordChannel = true;
                }
            });

            // Within the channels we go over the members. 
            if (channelMembers.hasOwnProperty(ircDisplayName)) {
                // User found for channel. 
                isCurrentlyInIRC = true;
            }


            // If the user is in the discord channel but not irc we will add the user. 
            if (!isCurrentlyInIRC && isInDiscordChannel) {
                ircDetails[guildID][channel].members[ircDisplayName] = {
                    discordName: guildMember.displayName,
                    discordState: guildMember.presence.status,
                    ircNick: ircDisplayName,
                    id: guildMember.id
                };

                console.log(`User ${ircDisplayName} joined ${channel}`);
                sendToIRC(guildID, `:${ircDisplayName}!${guildMember.id}@whatever JOIN #${channel}\r\n`);
                if (guildMember.presence === 'idle' || guildMember.presence === 'dnd') {
                    console.log(`User ${ircDisplayName} is away`);
                    sendToIRC(guildID, `:${ircDisplayName}!${guildMember.id}@whatever AWAY :Away\r\n`);
                }
                // Unlikely to happen, but just to be sure.
                if (guildMember.presence === 'offline' && configuration.showOfflineUsers) {
                    console.log(`User ${ircDisplayName} is away`);
                    sendToIRC(guildID, `:${ircDisplayName}!${guildMember.id}@whatever AWAY :Offline\r\n`);
                }
            }

            // If the user is currently in irc but not in the discord channel they have left the channel. 
            if (isCurrentlyInIRC && !isInDiscordChannel) {                
                console.log(`User ${ircDisplayName} left ${channel}`);
                sendToIRC(guildID, `:${ircDisplayName}!${guildMember.id}@whatever PART #${channel}\r\n`);
                delete ircDetails[guildID][channel].members[ircDisplayName];
            }

        }
    }
}

function guildMemberNickChange(guildID, oldIrcDisplayName, newIrcDisplayName, newDiscordDisplayName) {
    // First we go over the channels. 
    let foundInChannels = false;
    let memberId;
    for (let channel in ircDetails[guildID]) {
        if (ircDetails[guildID].hasOwnProperty(channel) && ircDetails[guildID][channel].joined) {

            let channelDetails = ircDetails[guildID][channel];
            let channelMembers = channelDetails.members;

            // Within the channels we go over the members. 
            if (channelMembers.hasOwnProperty(oldIrcDisplayName)) {
                let tempMember = channelMembers[oldIrcDisplayName];
                tempMember.displayName = newDiscordDisplayName;
                tempMember.ircNick = newIrcDisplayName;
                memberId = tempMember.id;
                delete ircDetails[guildID][channel].members[oldIrcDisplayName];
                ircDetails[guildID][channel].members[oldIrcDisplayName] = tempMember;
                foundInChannels = true;

            }
        }
    }
    if (foundInChannels) {
        console.log(`Changing nickname ${oldIrcDisplayName} into ${newIrcDisplayName}`);
        sendToIRC(guildID, `:${oldIrcDisplayName}!${memberId}@whatever NICK ${newIrcDisplayName}\r\n`);
    }
}

discordClient.on('guildMemberRemove', function(GuildMember) {
    if (ircClients.length > 0) {
        console.log('guildMemberRemove');
        const guildID = GuildMember.guild.id;
        const isBot = GuildMember.user.bot;
        const discriminator = GuildMember.user.discriminator;

        const ircDisplayName = ircNickname(GuildMember.displayName, isBot, discriminator);
        guildMemberNoMore(guildID, ircDisplayName, 'User removed');
    }
});

discordClient.on('presenceUpdate', function(oldMember, newMember) {
    if (ircClients.length > 0) {

        const guildID = newMember.guild.id;
        const isBot = newMember.user.bot;
        const discriminator = newMember.user.discriminator;

        const ircDisplayName = ircNickname(newMember.displayName, isBot, discriminator);
        const oldPresenceState = oldMember.presence.status;
        const newPresenceState = newMember.presence.status;

        // console.log(`presenceUpdate: ${ircDisplayName}  ${oldPresenceState} ->  ${newPresenceState}`);

        if (oldPresenceState === 'offline' && !configuration.showOfflineUsers) {
            guildMemberCheckChannels(guildID, ircDisplayName, newMember);
        } else if (newPresenceState === 'offline' && !configuration.showOfflineUsers) {
            guildMemberNoMore(guildID, ircDisplayName, 'User gone offline');
        } else if (newPresenceState === 'offline' && configuration.showOfflineUsers) {
            sendToIRC(guildID, `:${ircDisplayName}!${newMember.id}@whatever AWAY :Offline\r\n`);
        } else if (newPresenceState === 'dnd') {
            sendToIRC(guildID, `:${ircDisplayName}!${newMember.id}@whatever AWAY :Away\r\n`);
        } else if (newPresenceState === 'idle') {
            sendToIRC(guildID, `:${ircDisplayName}!${newMember.id}@whatever AWAY :Do not disturb\r\n`);
        } else if (oldPresenceState !== 'offline' && newPresenceState === 'online') {
            sendToIRC(guildID, `:${ircDisplayName}!${newMember.id}@whatever AWAY\r\n`);
        }
    }
});

discordClient.on('guildMemberUpdate', function(oldMember, newMember) {
    if (ircClients.length > 0) {
        console.log('guildMemberUpdate');
        const guildID = newMember.guild.id;
        const oldIsBot = oldMember.user.bot;
        const newIsBot = newMember.user.bot;
        const discriminator = newMember.user.discriminator;
        const oldIrcDisplayName = ircNickname(oldMember.displayName, oldIsBot, discriminator);
        const newIrcDisplayName = ircNickname(newMember.displayName, newIsBot, discriminator);
        const newDiscordDisplayName = newMember.displayName;

        if (oldIrcDisplayName !== newIrcDisplayName) {
            if (newMember.id === discordClient.user.id) {
                sendToIRC(newMember.guild.id, `:${oldIrcDisplayName}!${discordClient.user.id}@whatever NICK ${newIrcDisplayName}\r\n`);
            } else {
                guildMemberNickChange(guildID, oldIrcDisplayName, newIrcDisplayName, newDiscordDisplayName);
            }
        } else {
            guildMemberCheckChannels(guildID, newIrcDisplayName, newMember);
        }
    }
});

discordClient.on('guildMemberAdd', function(GuildMember) {
    if (ircClients.length > 0) {
        console.log('guildMemberAdd');
        const guildID = GuildMember.guild.id;
        const isBot = GuildMember.user.bot;
        const discriminator = GuildMember.user.discriminator;
        const ircDisplayName = ircNickname(GuildMember.displayName, isBot, discriminator);
        guildMemberCheckChannels(guildID, ircDisplayName, GuildMember);
    }
});


// Processing received messages 
discordClient.on('message', function(msg) {
    if (ircClients.length > 0 && msg.channel.type === 'text')  {
        const discordServerId = msg.guild.id;
        const authorDisplayName = msg.member.displayName;
        const isBot = msg.author.bot;
        const discriminator = msg.author.discriminator;
        const authorIrcName = ircNickname(authorDisplayName, isBot, discriminator);
        const channelName = msg.channel.name;

        // Only act on text channels and if the user has joined them in irc. 
        if (ircDetails[discordServerId][channelName].joined) {
            let ownNickname;

            ircClients.forEach(function(socket) {
                if (socket.discordid === discordServerId) {
                    ownNickname = socket.nickname;
                }
            });

            // IRC does not handle newlines. So we split the message up per line and send them seperatly.
            const messageArray = msg.content.split(/\r?\n/);

            const attachmentArray = msg.attachments.array();
            if (attachmentArray.length > 0) {
                attachmentArray.forEach(function(attachment) {
                    const filename = attachment.filename;
                    const url = attachment.url;
                    const attachmentLine = `${filename}: ${url}`;
                    messageArray.push(attachmentLine);
                });
            }

            let memberMentioned = false;

            const ownGuildMember = discordClient.guilds.get(discordServerId).members.get(discordClient.user.id);

            if (msg.mentions.users.array().length > 0) {
                if (msg.isMentioned(ownGuildMember)) {
                    memberMentioned = true;
                }
            }

            if (msg.mentions.roles.array().length > 0) {
                ownGuildMember.roles.array().forEach(function(role) {
                    if (msg.isMentioned(role)) {
                        memberMentioned = true;
                    }
                });

            }

            if (msg.mentions.channels.array().length > 0) {
                for (let channel in ircDetails[discordServerId]) {
                    if (ircDetails[discordServerId].hasOwnProperty(channel) && ircDetails[discordServerId][channel].joined) {
                        if (msg.isMentioned(channel)) {
                            memberMentioned = true;
                        }
                    }
                }
            }

            if (msg.mentions.everyone) {
                memberMentioned = true;
            }

            if (memberMentioned) {
                messageArray.push(`You are mentioned: ${ownNickname}`);
            }

            messageArray.forEach(function(line) {

                    const messageTemplate = `:${authorIrcName}!${msg.member.id}@whatever PRIVMSG #${channelName} :`;
                    const messageTemplateLength = messageTemplate.length;
                    const remainingLength = maxLineLength - messageTemplateLength;

                    const matchRegex = new RegExp(`[\\s\\S]{1,${remainingLength}}`, 'g');

                    const linesArray = line.match(matchRegex) || [];

                    linesArray.forEach(function(sendLine) {
                        // Trying to prevent messages from irc echoing back and showing twice.
                        if (ircDetails[discordServerId].lastPRIVMSG.indexOf(sendLine) < 0)  {
                            const lineToSend = parseDiscordLine(sendLine, discordServerId);
                            const message = `${messageTemplate}${lineToSend}\r\n`;
                            sendToIRC(discordServerId, message);
                        }
                    });

                
            });
        }
    }
    if (ircClients.length > 0 && msg.channel.type === 'dm')  {
        const discordServerId = 'DMserver';
        const authorDisplayName = msg.author.username;
        const authorIsBot = msg.author.bot;
        const authorDiscriminator = msg.author.discriminator;
        const authorIrcName = ircNickname(authorDisplayName, authorIsBot, authorDiscriminator);

        const recipientIsBot = msg.channel.recipient.bot;
        const recipientDiscriminator = msg.channel.recipient.discriminator;
        const recipient = ircNickname(msg.channel.recipient.username, recipientIsBot, recipientDiscriminator);
        let ownNickname;

        

        ircClients.forEach(function(socket) {
            if (socket.discordid === discordServerId) {
                ownNickname = socket.nickname;
            }
        });



        let messageTemplate;
        if (authorIrcName === ownNickname) {
            messageTemplate = `:${authorIrcName}!${msg.author.id}@whatever PRIVMSG ${recipient} :`;
        } else {
            messageTemplate = `:${authorIrcName}!${msg.author.id}@whatever PRIVMSG ${ownNickname} :`;
        }

        // IRC does not handle newlines. So we split the message up per line and send them seperatly.
        const messageArray = msg.content.split(/\r?\n/);
        
        const attachmentArray = msg.attachments.array();
        if (attachmentArray.length > 0) {
            attachmentArray.forEach(function(attachment) {
                const filename = attachment.filename;
                const url = attachment.url;
                const attachmentLine = `${filename}: ${url}`;
                messageArray.push(attachmentLine);
            });
        }

        messageArray.forEach(function(line) {



                const messageTemplateLength = messageTemplate.length;
                const remainingLength = maxLineLength - messageTemplateLength;

                const matchRegex = new RegExp(`[\\s\\S]{1,${remainingLength}}`, 'g');

                const linesArray = line.match(matchRegex) || [];

                linesArray.forEach(function(sendLine) {
                    // Trying to prevent messages from irc echoing back and showing twice.
                    if (ircDetails[discordServerId].lastPRIVMSG.indexOf(sendLine) < 0)  {
                        const lineToSend = parseDiscordLine(sendLine, discordServerId);
                        const message = `${messageTemplate}${lineToSend}\r\n`;
                        sendToIRC(discordServerId, message);
                    }
                });

            
        });

    }
});

// Join command given, let's join the channel. 
function joinCommand(channel, discordID) {
    let members = '';
    let memberListLines = [];
    const nickname = ircDetails[discordID].ircDisplayName;
    const memberlistTemplate = `:${configuration.ircServer.hostname} 353 ${nickname} @ #${channel} :`;
    const memberlistTemplateLength = memberlistTemplate.length;


    if (ircDetails[discordID].hasOwnProperty(channel)) {
        const channelProperties = ircDetails[discordID][channel];
        const channelContent = discordClient.channels.get(channelProperties.id);

        ircDetails[discordID][channel].joined = true;
        ircDetails[discordID][channel]['members'] = {};
        const channelTopic = channelProperties.topic;




        channelContent.members.array().forEach(function(member) {
            const isBot = member.user.bot;
            const discriminator = member.user.discriminator;   
            const displayMember = ircNickname(member.displayName, isBot, discriminator);

            if (member.presence.status === 'online' || 
            member.presence.status === 'idle' || 
            member.presence.status === 'dnd' || 
            (member.presence.status === 'offline' && configuration.showOfflineUsers)) {

                ircDetails[discordID][channel].members[displayMember] = {
                    discordName: member.displayName,
                    discordState: member.presence.status,
                    ircNick: displayMember,
                    id: member.id
                };
                const membersPlusDisplayMember = `${members} ${displayMember}`;
                const newLineLenght = membersPlusDisplayMember.length;
                const combinedLineLength = newLineLenght + memberlistTemplateLength;

                if (combinedLineLength < maxLineLength) {
                    members = `${members} ${displayMember}`;
                } else {
                    memberListLines.push(members);
                    members = displayMember;
                }
                
            }
        });

        memberListLines.push(members);
        

        const joinMSG = `:${nickname} JOIN #${channel}\r\n`;
        console.log(joinMSG);
        sendToIRC(discordID, joinMSG);

        // For some reason the topic is not showing yet in the client...
        const topicMSG = `:${configuration.ircServer.hostname} 332 ${nickname} #${channel} :${channelTopic}\r\n`;
        console.log(topicMSG);
        sendToIRC(discordID, topicMSG);

        const todayDate = new Date();
        const seconds = todayDate.getTime() / 1000;
        const topicMSG2 = `:${configuration.ircServer.hostname} 333 ${nickname} #${channel} noboyknows!orCares@whatever ${seconds}\r\n`;
        sendToIRC(discordID, topicMSG2);

        memberListLines.forEach(function(line) {
            const memberListMSG = `${memberlistTemplate}${line}\r\n`;
            console.log(memberListMSG);
            sendToIRC(discordID, memberListMSG);
        });


        const endListMSG = `:${configuration.ircServer.hostname} 366 ${nickname} #${channel} :End of /NAMES list.\r\n`;
        console.log(endListMSG);
        sendToIRC(discordID, endListMSG);


        setTimeout(function() {
            for (let key in ircDetails[discordID][channel].members) {
                if (ircDetails[discordID][channel].members.hasOwnProperty(key)) {

                    let member = ircDetails[discordID][channel].members[key];
                    let nickname = member.ircNick;
                    if (member.discordState === 'idle' || member.discordState === 'dnd' || (member.discordState === 'offline' && configuration.showOfflineUsers)) {

                        sendToIRC(discordID, `:${nickname}!${member.id}@whatever AWAY :Do not disturb\r\n`);

                    }
                }
            }
        }, 500);


    } else {
        sendToIRC(discordID, `:${configuration.ircServer.hostname} 473 ${nickname} #${channel} :Cannot join channel\r\n`);
    }
}

// List command, let's give back a list of channels.
function listCommand(discordID) {
    const nickname = ircDetails[discordID].ircDisplayName;
    const channels = discordClient.guilds.get(discordID).channels.array();
    let listResponse = [`:${configuration.ircServer.hostname} 321 ${nickname} Channel :Users Name\r\n`];

    channels.forEach(function(channel) {
        if (channel.type === 'text') {
            const channelname = channel.name,
                memberCount = channel.members.array().length,
                channeltopic = channel.topic;

            const channelDetails = `:${configuration.ircServer.hostname} 322 ${nickname} #${channelname} ${memberCount} :${channeltopic}\r\n`;
            listResponse.push(channelDetails);
        }
    });

    const endlist = `:${configuration.ircServer.hostname} 323 ${nickname} :End of channel list.\r\n`;

    listResponse.push(endlist);

    listResponse.forEach(function(line) {
        sendToIRC(discordID, line);
    });

}

// Part command given, let's part the channel. 
function partCommand(channel, discordID) {
    const nickname = ircDetails[discordID].ircDisplayName;
    if (ircDetails[discordID].hasOwnProperty(channel)) {
        // Let's clear the channel
        ircDetails[discordID][channel].members = {};
        ircDetails[discordID][channel].joined = false;
        sendToIRC(discordID, `:${nickname}!${discordClient.user.id}@whatever PART #${channel}\r\n`);
    }
}

function getDiscordUserFromIRC(recipient, discordID) {
    let returnmember;

    if (discordID === 'DMserver') {
        discordClient.users.array().forEach(function(user){
            const isBot = user.bot;
            const discriminator = user.discriminator;   
            const displayMember = ircNickname(user.username, isBot, discriminator);

            if (displayMember === recipient) {
                returnmember = user;
            }
        });
    } else {
        discordClient.guilds.get(discordID).members.array().forEach(function(member){
            const isBot = member.user.bot;
            const discriminator = member.user.discriminator;   
            const displayMember = ircNickname(member.displayName, isBot, discriminator);

            if (displayMember === recipient) {
                returnmember = member;
            }
        });
    }
    return returnmember;
}

//
// Irc Related functionality.
//
let ircServer = net.createServer(function(socket) {
    console.log('new socket');
    socket.setEncoding('utf8');

    ircClientCount++;
    socket.ircid = ircClientCount;
    socket.discordid = '';
    socket.nickname = '';
    socket.user = '';
    socket.pongcount = 1;
    socket.authenticated = false;

    socket.on('error', function(error) {
        console.log('Socket error: ', error);
        socket.end();

    });
    socket.on('data', function(data) {
        console.log('data:', data);
        // Data can be multiple lines. Here we put each line in an array. 
        let dataArray = data.match(/.+/g);
        dataArray.forEach(function(line) {
            let parsedLine = parseMessage(line);
            if (parsedLine.command === 'PASS') {
                const discordid = parsedLine.params[0];
                socket.discordid = discordid;
            }

            if (parsedLine.command === 'NICK' && socket.discordid) {
                const nickname = parsedLine.params[0];
                socket.nickname = nickname;
            }

            if (parsedLine.command === 'USER' && socket.discordid) {

                // So different irc clients use different formats for user it seems.
                // TODO: figure out how to properly parse this. 
                let username = parsedLine.params[0];
                let usernameAlternative = parsedLine.params[3];
                socket.user = username;
                let nickname = socket.nickname;

                // We are abusing some irc functionality here to add a tiny bit of security. 
                // The username the ircclient gives must match with that in the configuration.
                // If the username is correct and the discordId can be found we are in bussiness. 
                if (username === configuration.ircServer.username || usernameAlternative === configuration.ircServer.username) {
                    // Now we are connected let's change the nickname first to whatever it is on discord. 

                    // I am fairly certain there must be a simpler way to find out... but I haven't found it yet.
                    if (socket.discordid === 'DMserver') {
                        const newuser = discordClient.user.username;
                        const discriminator = discordClient.user.discriminator; 
                        const newNickname = ircNickname(newuser, false, discriminator);

                        ircDetails[socket.discordid]['discordDisplayName'] = newuser;
                        ircDetails[socket.discordid]['ircDisplayName'] = newNickname;
                        socket.user = newuser;
                        socket.nickname = newNickname;
                        socket.authenticated = true;
                        const connectArray = [
                            `:${nickname}!${discordClient.user.id}@whatever NICK ${newNickname}\r\n`,
                            `:${configuration.ircServer.hostname} 001 ${newNickname} :Welcome to the fake Internet Relay Chat Network ${newNickname}\r\n`,
                            `:${configuration.ircServer.hostname} 003 ${newNickname} :This server was created specifically for you\r\n`
                        ];

                        connectArray.forEach(function(line) {
                            socket.write(line);
                        });

                    } else if (discordClient.guilds.get(socket.discordid)) {
                        discordClient.guilds.get(socket.discordid).fetchMember(discordClient.user.id).then(function(guildMember) {
                            const newuser = guildMember.displayName;
                            const discriminator = discordClient.user.discriminator;
                            const newNickname = ircNickname(newuser, false, discriminator);

                            ircDetails[socket.discordid]['discordDisplayName'] = newuser;
                            ircDetails[socket.discordid]['ircDisplayName'] = newNickname;

                            socket.user = newuser;
                            socket.nickname = newNickname;
                            socket.authenticated = true;
                            const connectArray = [
                                `:${nickname}!${discordClient.user.id}@whatever NICK ${newNickname}\r\n`,
                                `:${configuration.ircServer.hostname} 001 ${newNickname} :Welcome to the fake Internet Relay Chat Network ${newNickname}\r\n`,
                                `:${configuration.ircServer.hostname} 003 ${newNickname} :This server was created specifically for you\r\n`
                            ];

                            connectArray.forEach(function(line) {
                                socket.write(line);
                            });


                        });
                    } else {
                        // Things are not working out, let's end this. 
                        socket.write(`:${configuration.ircServer.hostname} 464 ${nickname} :no\r\n`);
                         console.log('no 1')
                        socket.end();
                    }

                } else {
                    // Things are not working out, let's end this. 
                    console.log('no 2')
                    socket.write(`:${configuration.ircServer.hostname} 464 ${nickname} :no\r\n`);
                    socket.end();
                }
            }
            if (socket.authenticated) {

                switch (parsedLine.command) {
                    case 'JOIN':
                        const joinChannels = parsedLine.params[0].split(',');

                        joinChannels.forEach(function(channel) {
                            joinCommand(channel.substring(1), socket.discordid);
                        });

                        break;
                    case 'PART':
                        const partChannels = parsedLine.params[0].split(',');

                        partChannels.forEach(function(channel) {
                            partCommand(channel.substring(1), socket.discordid);
                        });
                        break;
                    case 'PRIVMSG':
                        const recipient = parsedLine.params[0];
                       
                        if (recipient.startsWith('#')) {
                            const channelName = recipient.substring(1);
                            const sendLine = parseIRCLine(parsedLine.params[1], socket.discordid, channelName);

                            if(ircDetails[socket.discordid].lastPRIVMSG.length > 3) {
                                ircDetails[socket.discordid].lastPRIVMSG.shift();
                            }

                            ircDetails[socket.discordid].lastPRIVMSG.push(sendLine.trim());
                            discordClient.channels.get(ircDetails[socket.discordid][channelName].id).sendMessage(sendLine);
                        } else {
                            const recipientUser = getDiscordUserFromIRC(recipient, socket.discordid);
                            const sendLine = parsedLine.params[1];
                            recipientUser.sendMessage(sendLine);

                            ircDetails[socket.discordid].lastPRIVMSG.push(sendLine.trim());
                            if(ircDetails[socket.discordid].lastPRIVMSG.length > 3) {
                                ircDetails[socket.discordid].lastPRIVMSG.shift();
                            }

                            if (socket.discordid !== 'DMserver') {
                                const messageTemplate = `:${socket.nickname}!${discordClient.user.id}@whatever PRIVMSG ${recipient} :PM Send: Note that replies will not arrive here but on the PM server\r\n`;
                                socket.write(messageTemplate);
                            } 
                            if(ircDetails[socket.discordid].lastPRIVMSG.length > 3) {
                                ircDetails[socket.discordid].lastPRIVMSG.shift();
                            }




                            
                        }
                        

                        break;
                    case 'QUIT':
                        for (let channel in ircDetails[socket.discordid]) {
                            if (ircDetails[socket.discordid].hasOwnProperty(channel) && ircDetails[socket.discordid][channel].joined) {
                                ircDetails[socket.discordid][channel].joined = false;
                            }
                        }
                        socket.end();
                        break;
                    case 'PING':
                        socket.write(`:${configuration.ircServer.hostname} PONG ${configuration.ircServer.hostname} :${socket.pongcount}\r\n`);
                        socket.pongcount = socket.pongcount + 1;
                        break;
                    case 'LIST':
                        listCommand(socket.discordid);

                }
            }
        });
    });

    ircClients.push(socket);

    // When a client is ended we remove it from the list of clients. 
    socket.on('end', function() {
        ircClients.splice(ircClients.indexOf(socket), 1);
    });

});

// Function for sending messages to the connect irc clients 
function sendToIRC(discordServerId, line) {
    ircClients.forEach(function(socket) {
        if (socket.discordid === discordServerId) {
            socket.write(line);
        }
    });
}

// Sending notices to all connected clients.
function sendGeneralNotice(noticeText) {
    ircClients.forEach(function(socket) {

        const notice = `:${configuration.ircServer.hostname} NOTICE ${socket.nickname} :${noticeText}\r\n`;
        socket.write(notice);
    });
}

// We want to be able to kill the process without having to deal with leftover connections.
process.on('SIGINT', function() {
    console.log('\nGracefully shutting down from SIGINT (Ctrl-C)');
    discordClient.destroy();
    ircServer.close();
    process.exit();
});