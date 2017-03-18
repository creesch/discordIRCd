// When false nothing will be logged. 
// Configuration goes here.
require('./config.js');

if (!configuration.DEBUG) {
    console.log = function() {};
}


const net = require('net');
const Discord = require("discord.js");
const EventEmitter = require('events');

// Generic emmitter.  
let chatEmitter = new EventEmitter();

//
// Let's ready some variables and stuff we will use later on.
//

// Object which will contain channel information.
let channelObject = {};

// Since we want a seperate connection for each discord server we will need to store our sockets. 
let ircClients = [];

// Simply used to give each new socket a unique number. 
let ircClientCount = 0;

// To prevent irc messages from echoing back through discord.
let lastPRIVMSG = '';

//
// Generic functions
//

function isEmptyObj(obj) {
    return (Object.keys(obj).length === 0 && obj.constructor === Object);
}
// Function that parses irc messages. 
// Shamelessly stolen from node-irc https://github.com/aredridel/node-ircd
function parseMessage(line) {
    let message = {};
    let m = /(:[^ ]+ )?([A-Z0-9]+)(?: (.*))?/i.exec(line);
    if (!m) {
        message.error = 'Unable to parse message';
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

// Make nicknames work for irc. 
function ircNickname(discordDisplayName) {
    return discordDisplayName.replace(/[^a-zA-Z0-9а-я_\\[\]\{\}\^`\|]/g, '_');
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
    const mentionRegex = /(<@!?\d{1,}?>)/g;
    const mentionFound = line.match(mentionRegex);

    if (mentionFound) {
        mentionFound.forEach(function(mention) {
            const userID = mention.replace(/<@!?(\d{1,}?)>/, '$1');
            const userName = ircNickname(discordClient.guilds.get(discordID).members.get(userID).displayName);
            const replaceRegex = new RegExp(mention, 'g');
            if (userName) {
                line = line.replace(replaceRegex, `@${userName}`);
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

            const userID = channelObject[discordID][channel].members[userNickname].id;
            const replaceRegex = new RegExp(mention, 'g');
            if (userID) {
                line = line.replace(replaceRegex, `<@!${userID}>`);
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
});

// Emitted when the Client tries to reconnect after being disconnected.
discordClient.on('reconnecting', function() {
    console.log('reconnecting');
});

// Emitted whenever the client websocket is disconnected.
discordClient.on('disconnect', function(event) {
    console.log('disconnected', event);
});

// Emitted for general warnings.
discordClient.on('warn', function(info) {
    console.log('disconnected', info);
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
    discordClient.channels.array().forEach(function(channel) {
        // Of course only for channels. 
        if (channel.type === 'text') {
            const guildID = channel.guild.id,
                channelName = channel.name,
                channelID = channel.id,
                channelTopic = channel.topic || 'No topic';

            if (!channelObject.hasOwnProperty(guildID)) {
                channelObject[guildID] = {};
            }
            channelObject[guildID][channelName] = {
                id: channelID,
                joined: false,
                topic: channelTopic
            };
        }
    });

    ircServer.listen(configuration.ircServer.listenPort);
});

//
// Acting on events
//

// There are multiple events that indicate a users is no longer on the server. 
// We abuse the irc QUIT: message for this even if people are banned. 
function guildMemberNoMore(guildID, ircDisplayName, noMoreReason) {
    let found = false;
    // First we go over the channels. 
    for (var channel in channelObject[guildID]) {
        if (channelObject[guildID].hasOwnProperty(channel) && channelObject[guildID][channel].joined) {

            let channelMembers = channelObject[guildID][channel].members;
            // Within the channels we go over the members. 
            if (channelMembers.hasOwnProperty(ircDisplayName)) {
                if (!found) {
                    let memberDetails = channelObject[guildID][channel].members[ircDisplayName];
                    console.log(`User ${ircDisplayName} quit ${noMoreReason}`);
                    sendToIRC(guildID, `:${ircDisplayName}!${memberDetails.id}@whatever QUIT :${noMoreReason}\r\n`);
                    found = true;
                }
                delete channelObject[guildID][channel].members[ircDisplayName];
            }
        }
    }
}

function guildMemberCheckChannels(guildID, ircDisplayName, guildMember) {
    // First we go over the channels. 
    for (var channel in channelObject[guildID]) {
        if (channelObject[guildID].hasOwnProperty(channel) && channelObject[guildID][channel].joined) {
            let isInDiscordChannel = false;
            let isCurrentlyInIRC = false;

            let channelDetails = channelObject[guildID][channel];
            let channelMembers = channelDetails.members;
            let channelID = channelDetails.id;

            //Let's check the discord channel. 
            let discordMemberArray = discordClient.guilds.get(guildID).channels.get(channelID).members.array();
            discordMemberArray.forEach(function(discordMember) {
                if (guildMember.displayName === discordMember.displayName && guildMember.presence.status !== 'offline') {
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
                channelObject[guildID][channel].members[ircDisplayName] = {
                    discordName: guildMember.displayName,
                    discordState: guildMember.presence.status,
                    ircNick: ircDisplayName,
                    id: guildMember.id
                };

                console.log(`User ${ircDisplayName} joined ${channel}`);
                sendToIRC(guildID, `:${ircDisplayName}!${guildMember.id}@whatever JOIN #${channel}\r\n`);
                if (guildMember.presence === 'idle' || guildMember.presence === 'dnd') {
                    console.log(`User ${ircDisplayName} is back`);
                    sendToIRC(guildID, `:${ircDisplayName}!${guildMember.id}@whatever AWAY :Away\r\n`);
                }
            }

            // If the user is currently in irc but not in the discord channel they have left the channel. 
            if (isCurrentlyInIRC && !isInDiscordChannel) {
                console.log(`User ${ircDisplayName} left ${channel}`);
                sendToIRC(guildID, `:${ircDisplayName}!${guildMember.id}@whatever PART #${channel}\r\n`);
                delete channelObject[guildID][channel].members[ircDisplayName];
            }

        }
    }
}

function guildMemberNickChange(guildID, oldIrcDisplayName, newIrcDisplayName, newDiscordDisplayName) {
    // First we go over the channels. 
    let foundInChannels = false;
    let memberId;
    for (var channel in channelObject[guildID]) {
        if (channelObject[guildID].hasOwnProperty(channel) && channelObject[guildID][channel].joined) {

            let channelDetails = channelObject[guildID][channel];
            let channelMembers = channelDetails.members;

            // Within the channels we go over the members. 
            if (channelMembers.hasOwnProperty(oldIrcDisplayName)) {
                let tempMember = channelMembers[oldIrcDisplayName];
                tempMember.displayName = newDiscordDisplayName;
                tempMember.ircNick = newIrcDisplayName;
                memberId = tempMember.id;
                delete channelObject[guildID][channel].members[oldIrcDisplayName];
                channelObject[guildID][channel].members[oldIrcDisplayName] = tempMember;
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
        const ircDisplayName = ircNickname(GuildMember.displayName);
        guildMemberNoMore(guildID, ircDisplayName, 'User removed');
    }
});

discordClient.on('presenceUpdate', function(oldMember, newMember) {
    if (ircClients.length > 0) {

        const guildID = newMember.guild.id;
        const ircDisplayName = ircNickname(newMember.displayName);
        const oldPresenceState = oldMember.presence.status;
        const newPresenceState = newMember.presence.status;

        console.log(`presenceUpdate: ${ircDisplayName}  ${oldPresenceState} ->  ${newPresenceState}`);

        if (oldPresenceState === 'offline') {
            guildMemberCheckChannels(guildID, ircDisplayName, newMember);
        } else if (newPresenceState === 'offline') {
            guildMemberNoMore(guildID, ircDisplayName, 'User gone offline');
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
        const oldIrcDisplayName = ircNickname(oldMember.displayName);
        const newIrcDisplayName = ircNickname(newMember.displayName);
        const newDiscordDisplayName = newMember.displayName;

        if (oldIrcDisplayName !== newIrcDisplayName) {
            guildMemberNickChange(guildID, oldIrcDisplayName, newIrcDisplayName, newDiscordDisplayName);
        } else {
            guildMemberCheckChannels(guildID, newIrcDisplayName, newMember);
        }
    }
});

discordClient.on('guildMemberAdd', function(GuildMember) {
    if (ircClients.length > 0) {
        console.log('guildMemberAdd');
        const guildID = GuildMember.guild.id;
        const ircDisplayName = ircNickname(GuildMember.displayName);
        guildMemberCheckChannels(guildID, ircDisplayName, GuildMember);
    }
});


// Processing received messages 
discordClient.on('message', function(msg) {
    if (ircClients.length > 0) {
        const discordServerId = msg.guild.id;
        const authorDisplayName = msg.member.displayName;
        const authorIrcName = ircNickname(authorDisplayName);
        const channelName = msg.channel.name;
        // Only act on text channels and if the user has joined them in irc. 

        if (msg.channel.type === 'text' && channelObject[discordServerId][channelName].joined) {
            console.log('message');

            // We need the guild id to send the message to the correct socket. 

            // IRC does not handle newlines. So we split the message up per line and send them seperatly.
            const messageArray = msg.content.split(/\r?\n/);

            messageArray.forEach(function(line) {
                // Trying to prevent messages from irc echoing back and showing twice.
                if (lastPRIVMSG !== line) {
                    const lineToSend = parseDiscordLine(line, discordServerId, channelName);
                    const message = `:${authorIrcName}!${msg.member.id}@test PRIVMSG #${channelName} :${lineToSend}\r\n`;
                    sendToIRC(discordServerId, message);
                }
            });
        }
    }
});

// Join command given, let's join the channel. 
chatEmitter.on('joinCommand', function(details) {
    const channel = details.channel;
    const discordID = details.discordID;
    let members = '';
    const nickname = channelObject[discordID].ircDisplayName;

    if (channelObject[discordID].hasOwnProperty(channel)) {
        const channelProperties = channelObject[discordID][channel];
        const channelContent = discordClient.channels.get(channelProperties.id);

        channelObject[discordID][channel].joined = true;
        channelObject[discordID][channel]['members'] = {};
        const channelTopic = channelProperties.topic;




        channelContent.members.array().forEach(function(member) {
            const displayMember = ircNickname(member.displayName);

            if (member.presence.status === 'online' || member.presence.status === 'idle' || member.presence.status === 'dnd') {
                channelObject[discordID][channel].members[displayMember] = {
                    discordName: member.displayName,
                    discordState: member.presence.status,
                    ircNick: displayMember,
                    id: member.id
                };
                members = `${members} ${displayMember}`;
            }
        });

        const joinMSG = `:${nickname} JOIN #${channel}\r\n`;
        console.log(joinMSG);
        sendToIRC(discordID, joinMSG);

        // For some reason the topic is not showing yet in the client...
        const topicMSG = `:${configuration.ircServer.hostname} 332 ${nickname} #${channel} :${channelTopic}\r\n`;
        console.log(topicMSG);
        sendToIRC(discordID, topicMSG);

        const memberListMSG = `:${configuration.ircServer.hostname} 353 ${nickname} @ #${channel} :${members}\r\n`;
        console.log(memberListMSG);
        sendToIRC(discordID, memberListMSG);

        const endListMSG = `:${configuration.ircServer.hostname} 366 ${nickname} #${channel} :End of /NAMES list.\r\n`;
        console.log(endListMSG);
        sendToIRC(discordID, endListMSG);


        setTimeout(function() {
            for (var key in channelObject[discordID][channel].members) {
                if (channelObject[discordID][channel].members.hasOwnProperty(key)) {

                    let member = channelObject[discordID][channel].members[key];
                    let nickname = member.ircNick;
                    if (member.discordState === 'idle' || member.discordState === 'dnd') {

                        sendToIRC(discordID, `:${nickname}!${member.id}@whatever AWAY :Do not disturb\r\n`);

                    }
                }
            }
        }, 500);
    } else {
        sendToIRC(discordID, `:${configuration.ircServer.hostname} 473 ${nickname} #${channel} :Cannot join channel\r\n`);
    }
});


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
    socket.authenticated = false;

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

                let username = parsedLine.params[0];
                socket.user = username;
                let nickname = socket.nickname;

                // We are abusing some irc functionality here to add a tiny bit of security. 
                // The username the ircclient gives must match with that in the configuration.
                // If the username is correct and the discordId can be found we are in bussiness. 
                if (username === configuration.ircServer.username && channelObject[socket.discordid]) {
                    // Now we are connected let's change the nickname first to whatever it is on discord. 

                    // I am fairly certain there must be a simpler way to find out... but I haven't found it yet.
                    discordClient.guilds.get(socket.discordid).fetchMember(discordClient.user.id).then(function(guildMember) {
                        const newuser = guildMember.displayName;
                        const newNickname = ircNickname(newuser);

                        channelObject[socket.discordid]['discordDisplayName'] = newuser;
                        channelObject[socket.discordid]['ircDisplayName'] = newNickname;

                        socket.user = newuser;
                        socket.nickname = newNickname;
                        socket.authenticated = true;
                        const connectArray = [
                            `:${nickname}!${discordClient.user.id}@okay NICK ${newNickname}\r\n`,
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
                    socket.end();
                }
            }
            if (socket.authenticated) {

                switch (parsedLine.command) {
                    case 'JOIN':
                        const joinChannels = parsedLine.params[0].split(',');

                        joinChannels.forEach(function(channel) {
                            chatEmitter.emit('joinCommand', {
                                channel: channel.substring(1),
                                discordID: socket.discordid
                            });
                        });

                        break;
                    case 'PRIVMSG':
                        const channelName = parsedLine.params[0].substring(1);
                        const sendLine = parseIRCLine(parsedLine.params[1], socket.discordid, channelName);
                        lastPRIVMSG = sendLine;
                        discordClient.channels.get(channelObject[socket.discordid][channelName].id).sendMessage(sendLine);
                        break;
                    case 'QUIT':
                        socket.end();
                        break;
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

// We want to be able to kill the process without having to deal with leftover connections.
process.on('SIGINT', function() {
    console.log('\nGracefully shutting down from SIGINT (Ctrl-C)');
    discordClient.destroy();
    ircServer.close();
    process.exit();
});