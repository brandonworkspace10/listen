//
//  SafariWebExtensionHandler.swift
//  Listen Extension
//
//  Created by Brandon Gil on 11/1/26.
//

import Foundation

// Safari needs this class to load the extension. Listen doesn't use native messaging, so any request is
// answered with nothing and nothing is logged.
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        context.completeRequest(returningItems: [], completionHandler: nil)
    }

}
