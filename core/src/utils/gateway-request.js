const crypto = require('node:crypto');
const { Buffer } = require('node:buffer');
const { types } = require('./proto');
const { toLong } = require('./utils');

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN_BODY_MIN_LENGTH = 64;
const TOKEN_BODY_MAX_LENGTH = 127;

function generateGatewayRequestToken() {
    const length = crypto.randomInt(TOKEN_BODY_MIN_LENGTH, TOKEN_BODY_MAX_LENGTH + 1);
    let token = '';
    for (let index = 0; index < length; index += 1) {
        token += TOKEN_ALPHABET[crypto.randomInt(TOKEN_ALPHABET.length)];
    }
    return `${token}=`;
}

function encodeGatewayRequest(serviceName, methodName, bodyBytes, clientSeq, serverSeq) {
    const message = types.GateMessage.create({
        meta: {
            service_name: serviceName,
            method_name: methodName,
            message_type: 1,
            client_seq: toLong(clientSeq),
            server_seq: toLong(serverSeq),
        },
        body: bodyBytes || Buffer.alloc(0),
        token: generateGatewayRequestToken(),
    });
    return types.GateMessage.encode(message).finish();
}

module.exports = {
    generateGatewayRequestToken,
    encodeGatewayRequest,
};
