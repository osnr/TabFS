//
//  SafariWebExtensionHandler.swift
//  TabFS Extension
//
//  Created by Omar Rizwan on 1/31/21.
//

import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    
	func beginRequest(with context: NSExtensionContext) {
        
        let item = context.inputItems[0] as! NSExtensionItem
        guard let message = item.userInfo?["message"] as? [AnyHashable: Any] else { return }

        guard message["op"] as! String == "safari_did_connect" else { return }
        
        // The XPC service is a subprocess that lives outside the macOS App Sandbox.
        // (Safari extension native code, including this file, has to live in the sandbox.)
        // It can do forbidden things like spawn tabfs filesystem and set up WebSocket server.
        
        // We only use one native message to bootstrap the XPC service, then do all communications
        // to that service (which in turn talks to tabfs.c) over WebSocket instead.
        // (Safari makes doing native messaging quite painful, so we try to avoid it.
        // It forces the browser to pop to front if you message Safari in the obvious way,
        // for instance: https://developer.apple.com/forums/thread/122232
        // And with the WebSocket, the XPC service can talk straight to background.js, whereas
        // native messaging would require us here to sit in the middle.)

        let connection = NSXPCConnection(serviceName: "com.rsnous.TabFSService")
        connection.remoteObjectInterface = NSXPCInterface(with: TabFSServiceProtocol.self)
        connection.resume()
        
        let service = connection.remoteObjectProxyWithErrorHandler { error in
            os_log(.default, "Received error:  %{public}@", error as CVarArg)
        } as? TabFSServiceProtocol
        
        // Need this one XPC call to actually initialize the service.
        service?.start() {
            os_log(.default, "Response from XPC service")
            
            // FIXME: report port back?
            let response = NSExtensionItem()
            response.userInfo = [ "message": "alive" ]
            // This response (over native messaging) prompts background.js to
            // connect to the WebSocket server that the XPC service should now be running.
            context.completeRequest(returningItems: [response]) { (what) in
                print(what)
            }
        }
        
        return
    }
    
}
