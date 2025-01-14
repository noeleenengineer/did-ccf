// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the Apache 2.0 License.
import { Request, Response } from '@microsoft/ccf-app';
import {
  AuthenticatedRequestError,
  IdentifierNotProvided,
  KeyNotConfigured,
} from '../../../errors';
import {
  AuthenticatedIdentity,
  ControllerDocument,
  EcdsaCurve,
  EddsaCurve,
  IdentifierStore,
  KeyAlgorithm,
  KeyPair,
  KeyPairCreator,
  KeyState,
  KeyUse,
  RequestParameters,
  RequestParser,
  VerificationMethodRelationship,
  VerificationMethodType,
} from '../../../models';

/**
 * Rolls the current key pair associated with the controller
 * identifier using the existing key algorithm as the
 * algorithm. The request querystring parameter
 * @param {Request} request passed to the API.
 *
 * @description The following optional query string parameters
 * can be provided in the request:
 *
 *    @param {KeyAlgorithm} request.alg specifying the key algorithm to use.
 *    @param {number} request.size specifying the key size.
 *    @param {EcdsaCurve} request.curve specifying the key size.
 *    @param {KeyUse} request.use specifying the key use.
 */

export function roll (request: Request): Response {
  // Get the authentication details of the caller
  const authenticatedIdentity = new AuthenticatedIdentity(request.caller);
  const requestParser = new RequestParser(request);
  const identifierId: string = requestParser.identifier;

  // Get the optional parameters from the request
  const keyUse = requestParser.getQueryParameter<KeyUse>('use', KeyUse.Signing);

  // Check an identifier has been provided and
  // if not return 400 Bad Request
  if (!identifierId) {
    const identifierNotProvided = new IdentifierNotProvided(authenticatedIdentity);
    console.log(identifierNotProvided);
    return identifierNotProvided.toErrorResponse();
  }

  try {
    // Try read the identifier from the store
    const identifierStore = new IdentifierStore();

    // Try read the identifier from the store
    const identifier = identifierStore.read(identifierId, authenticatedIdentity);

    // Get the current key for the specified use from the members keys then
    // 1. Get the current key, check if the same key type is being generated as part of the roll. If there
    // is no current key todays behavior is to throw, but perhaps it should just create a new key (could
    // be enabled by a query parameter?).
    // 2. Generate the new key.
    // 3. Update the current key state to historical.
    // 4. Remove the current key's private key.
    const currentKey = identifier.getCurrentKey(keyUse);

    if (!currentKey) {
      const keyNotConfigured = new KeyNotConfigured(authenticatedIdentity, identifierId, keyUse);
      // Send to the console as an error since this is not a client recoverable error.
      console.error(keyNotConfigured);
      return keyNotConfigured.toErrorResponse();
    }

    // We have matched an identifier, so let's parse the
    // query string to see if any alg and curve params
    // have been specified. If not just use the properties
    // of the existing key.
    const algorithm = requestParser.getQueryParameter<KeyAlgorithm>(RequestParameters.Algorithm, currentKey.algorithm);
    const size = requestParser.getQueryParameter<number>(RequestParameters.KeySize, currentKey.size);
    const curve = requestParser.getQueryParameter<EcdsaCurve | EddsaCurve>(RequestParameters.Curve, currentKey?.curve);

    // Now generate the new key
    const newKey: KeyPair = KeyPairCreator.createKey(algorithm, keyUse, size, curve);

    // Update the current key state and delete private key
    currentKey.state = KeyState.Historical;
    delete currentKey.privateKey;

    // Now add the new keys to the member
    identifier.keyPairs.push(newKey);

    // Add the new verification method to the controller document
    // and then update the store
    const controllerDocument = Object.setPrototypeOf(identifier.controllerDocument, ControllerDocument.prototype);
    const verificationMethodRelationship =
      keyUse === KeyUse.Signing ?
      VerificationMethodRelationship.Authentication :
      VerificationMethodRelationship.KeyAgreement;

    controllerDocument.addVerificationMethod({
      id: newKey.id,
      controller: identifier.controllerDocument.id,
      type: VerificationMethodType.JsonWebKey2020,
      publicKeyJwk: newKey.asJwk(false),
    }, [verificationMethodRelationship]);

    // Store the new identifier
    identifierStore.addOrUpdate(identifier);

    // Return 201 and the controller document representing the updated controller document.
    return {
      statusCode: 201,
      body: identifier.controllerDocument,
    };
  } catch (error) {
    if (error instanceof AuthenticatedRequestError) {
      return (<AuthenticatedRequestError>error).toErrorResponse();
    }

    // Not derived from `AuthenticatedRequestError`
    // so throw.
    throw (error);
  }
}
