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
        // It can do forbidden things like spawn tabfs filesystem and set up WebSocket server.
        
        let connection = NSXPCConnection(serviceName: "com.rsnous.TabFSService")
        connection.remoteObjectInterface = NSXPCInterface(with: TabFSServiceProtocol.self)
        connection.resume()
        
        let service = connection.remoteObjectProxyWithErrorHandler { error in
            os_log(.default, "Received error:  %{public}@", error as! CVarArg)
        } as? TabFSServiceProtocol
        
        // need this one XPC call to actually initialize the service
        service?.upperCaseString("hello XPC") { response in
            os_log(.default, "Response from XPC service:  %{public}@", response)
            
            // FIXME: report port back?
            let response = NSExtensionItem()
            response.userInfo = [ "message": [ "aResponse to": "moop" ] ]
            context.completeRequest(returningItems: [response]) { (what) in
                print(what)
            }
        }
        
        return
    }
    
}
