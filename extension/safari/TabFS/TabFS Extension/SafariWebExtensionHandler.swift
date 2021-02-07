//
//  SafariWebExtensionHandler.swift
//  TabFS Extension
//
//  Created by Omar Rizwan on 1/31/21.
//

import SafariServices
import SafariServices.SFSafariApplication
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    
	func beginRequest(with context: NSExtensionContext) {
        
        os_log(.default, "Received message from browser.runtime.sendNativefffMessage: %@", context as! CVarArg)
        
        let item = context.inputItems[0] as! NSExtensionItem
        guard let message = item.userInfo?["message"] as? [AnyHashable: Any] else { return }
        
        if message["op"] as! String == "safari_did_connect" {
            FSProcessManager.shared.start()
//
//            let response = NSExtensionItem()
//            response.userInfo = [ "message": [ "aResponse to": "moop" ] ]
//            context.completeRequest(returningItems: [response], completionHandler: nil)
            
            return
        }
//
//        os_log(.default, "Received message from browser.runtime.sendNativeMessage: %@", op as! CVarArg)
        
        FSProcessManager.shared.respond(message)
//
//        let response = NSExtensionItem()
//        response.userInfo = [ "message": [ "Response to": op ] ]
//
//        // How do I get too the app????
//
//        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
    
}
