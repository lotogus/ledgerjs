/********************************************************************************
 *   Ledger Node JS API
 *   (c) 2017-2018 Ledger
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 ********************************************************************************/
//@flow

import type Transport from "@ledgerhq/hw-transport";
import {
  splitPath,
  foreach,
  encodeEd25519PublicKey,
  verifyEd25519Signature,
  checkCasinocoinBip32Path,
  hash
} from "./utils";

const CLA = 0xe0;
const INS_GET_PK = 0x02;
const INS_SIGN_TX = 0x04;
const INS_GET_CONF = 0x06;
const INS_SIGN_TX_HASH = 0x08;

const APDU_MAX_SIZE = 150;
const P1_FIRST_APDU = 0x00;
const P1_MORE_APDU = 0x80;
const P2_LAST_APDU = 0x00;
const P2_MORE_APDU = 0x80;

const SW_OK = 0x9000;
const SW_CANCEL = 0x6985;
const SW_UNKNOWN_OP = 0x6c24;
const SW_MULTI_OP = 0x6c25;
const SW_SAFE_MODE = 0x6c66;
const SW_UNSUPPORTED = 0x6d00;

/**
 * Casinocoin API
 *
 * @example
 * import Csc from "@ledgerhq/hw-app-csc";
 * const csc = new Csc(transport)
 */
export default class Csc {
  transport: Transport<*>;

  constructor(transport: Transport<*>) {
    this.transport = transport;
    transport.decorateAppAPIMethods(
      this,
      ["getAppConfiguration", "getPublicKey", "signTransaction", "signHash"],
      "l0v"
    );
  }

  getAppConfiguration(): Promise<{
    version: string
  }> {
    return this.transport.send(CLA, INS_GET_CONF, 0x00, 0x00).then(response => {
      let multiOpsEnabled = response[0] === 0x01 || response[1] < 0x02;
      let version = "" + response[1] + "." + response[2] + "." + response[3];
      return {
        version: version,
        multiOpsEnabled: multiOpsEnabled
      };
    });
  }

  /**
   * get Casinocoin public key for a given BIP 32 path.
   * @param path a path in BIP 32 format
   * @option boolValidate optionally enable key pair validation
   * @option boolDisplay optionally enable or not the display
   * @return an object with the publicKey
   * @example
   * csc.getPublicKey("44'/148'/0'").then(o => o.publicKey)
   */
  getPublicKey(
    path: string,
    boolValidate?: boolean,
    boolDisplay?: boolean
  ): Promise<{ publicKey: string }> {
    let pathElts = splitPath(path);
    let buffer = new Buffer(1 + pathElts.length * 4);
    buffer[0] = pathElts.length;
    pathElts.forEach((element, index) => {
      buffer.writeUInt32BE(element, 1 + 4 * index);
    });
    let verifyMsg = Buffer.from("via lumina", "ascii");
    buffer = Buffer.concat([buffer, verifyMsg]);
    return this.transport
      .send(
        CLA,
        INS_GET_PK,
        boolValidate ? 0x01 : 0x00,
        boolDisplay ? 0x01 : 0x00,
        buffer
      )
      .then(response => {
        // response = Buffer.from(response, 'hex');
        let offset = 0;
        let rawPublicKey = response.slice(offset, offset + 32);
        offset += 32;
        let publicKey = encodeEd25519PublicKey(rawPublicKey);
        if (boolValidate) {
          let signature = response.slice(offset, offset + 64);
          if (!verifyEd25519Signature(verifyMsg, signature, rawPublicKey)) {
            throw new Error(
              "Bad signature. Keypair is invalid. Please report this."
            );
          }
        }
        return {
          publicKey: publicKey
        };
      });
  }

  /**
   * sign a Casinocoin transaction.
   * @param path a path in BIP 32 format
   * @param transaction signature base of the transaction to sign
   * @return an object with the signature and the status
   * @example
   * csc.signTransaction("44'/148'/0'", signatureBase).then(o => o.signature)
   */
  signTransaction(
    path: string,
    transaction: Buffer
  ): Promise<{ signature: Buffer }> {
    checkCasinocoinBip32Path(path);

    let apdus = [];
    let response;

    let pathElts = splitPath(path);
    let bufferSize = 1 + pathElts.length * 4;
    let buffer = Buffer.alloc(bufferSize);
    buffer[0] = pathElts.length;
    pathElts.forEach(function(element, index) {
      buffer.writeUInt32BE(element, 1 + 4 * index);
    });
    let chunkSize = APDU_MAX_SIZE - bufferSize;
    if (transaction.length <= chunkSize) {
      // it fits in a single apdu
      apdus.push(Buffer.concat([buffer, transaction]));
    } else {
      // we need to send multiple apdus to transmit the entire transaction
      let chunk = Buffer.alloc(chunkSize);
      let offset = 0;
      transaction.copy(chunk, 0, offset, chunkSize);
      apdus.push(Buffer.concat([buffer, chunk]));
      offset += chunkSize;
      while (offset < transaction.length) {
        let remaining = transaction.length - offset;
        chunkSize = remaining < APDU_MAX_SIZE ? remaining : APDU_MAX_SIZE;
        chunk = Buffer.alloc(chunkSize);
        transaction.copy(chunk, 0, offset, offset + chunkSize);
        offset += chunkSize;
        apdus.push(chunk);
      }
    }
    return foreach(apdus, (data, i) =>
      this.transport
        .send(
          CLA,
          INS_SIGN_TX,
          i === 0 ? P1_FIRST_APDU : P1_MORE_APDU,
          i === apdus.length - 1 ? P2_LAST_APDU : P2_MORE_APDU,
          data,
          [SW_OK, SW_CANCEL, SW_UNKNOWN_OP, SW_MULTI_OP]
        )
        .then(apduResponse => {
          response = apduResponse;
        })
    ).then(() => {
      let status = Buffer.from(
        response.slice(response.length - 2)
      ).readUInt16BE(0);
      if (status === SW_OK) {
        let signature = Buffer.from(response.slice(0, response.length - 2));
        return {
          signature: signature
        };
      } else if (status === SW_UNKNOWN_OP) {
        // pre-v2 app version: fall back on hash signing
        return this.signHash_private(path, hash(transaction));
      } else if (status === SW_MULTI_OP) {
        // multi-operation transaction: attempt hash signing
        return this.signHash_private(path, hash(transaction));
      } else {
        throw new Error("Transaction approval request was rejected");
      }
    });
  }

  /**
   * @deprecated
   * sign a Casinocoin transaction hash.
   * @param path a path in BIP 32 format
   * @param hash hash of the transaction to sign
   * @return an object with the signature
   * @example
   * csc.signHash("44'/148'/0'", hash).then(o => o.signature)
   */
  signHash(path: string, hash: Buffer): Promise<{ signature: Buffer }> {
    return this.signHash_private(path, hash);
  }

  signHash_private(path: string, hash: Buffer): Promise<{ signature: Buffer }> {
    let pathElts = splitPath(path);
    let buffer = Buffer.alloc(1 + pathElts.length * 4);
    buffer[0] = pathElts.length;
    pathElts.forEach(function(element, index) {
      buffer.writeUInt32BE(element, 1 + 4 * index);
    });
    buffer = Buffer.concat([buffer, hash]);
    return this.transport
      .send(CLA, INS_SIGN_TX_HASH, 0x00, 0x00, buffer, [
        SW_OK,
        SW_CANCEL,
        SW_SAFE_MODE,
        SW_UNSUPPORTED
      ])
      .then(response => {
        let status = Buffer.from(
          response.slice(response.length - 2)
        ).readUInt16BE(0);
        if (status === SW_OK) {
          let signature = Buffer.from(response.slice(0, response.length - 2));
          return {
            signature: signature
          };
        }
        if (status === SW_SAFE_MODE) {
          throw new Error(
            "To sign multi-operation transactions 'Unsafe mode' must be enabled in the app settings"
          );
        } else if (status === SW_UNSUPPORTED) {
          throw new Error("Multi-operation transactions are not supported");
        } else {
          throw new Error("Transaction approval request was rejected");
        }
      });
  }
}
