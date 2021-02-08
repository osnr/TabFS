//
//  SafariWebExtensionHandler.swift
//  TabFS Extension
//
//  Created by Omar Rizwan on 1/31/21.
//

import SafariServices
import SafariServices.SFSafariApplication
import os.log

class TabFSServiceManager: TabFSServiceConsumerProtocol {
    static let shared = TabFSServiceManager()
    
    var service: TabFSServiceProtocol!
    
    func connect() {
        let connection = NSXPCConnection(serviceName: "com.rsnous.TabFSService")
        
        connection.remoteObjectInterface = NSXPCInterface(with: TabFSServiceProtocol.self)
        
        connection.exportedInterface = NSXPCInterface(with: TabFSServiceConsumerProtocol.self)
        connection.exportedObject = self
        
        connection.resume()
        
        service = connection.remoteObjectProxyWithErrorHandler { error in
            os_log(.default, "Received error:  %{public}@", error as! CVarArg)
        } as? TabFSServiceProtocol
        
        service?.upperCaseString("hello XPC") { response in
            os_log(.default, "Response from XPC service:  %{public}@", response)
        }
    }
    
    func request(_ req: Data) {
        SFSafariApplication.dispatchMessage(
            withName: "ToSafari",
            toExtensionWithIdentifier: "com.rsnous.TabFS-Extension",
            userInfo: try! JSONSerialization.jsonObject(with: req, options: []) as! [String : Any]
        ) { error in
            debugPrint("Message attempted. Error info: \(String.init(describing: error))")
        }
    }
    
    func response(_ resp: [AnyHashable: Any]) {
        try! service.response(JSONSerialization.data(withJSONObject: resp, options: []))
    }
}

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    
	func beginRequest(with context: NSExtensionContext) {
        
        os_log(.default, "TabFSmsg Received message from browser.runtime.sendNativefffMessage: %@", context as! CVarArg)
        
        let item = context.inputItems[0] as! NSExtensionItem
        
        os_log(.default, "TabFSmsg item.userInfo %{public}@", item.userInfo as! CVarArg)
        guard let message = item.userInfo?["message"] as? [AnyHashable: Any] else { return }
        
        if message["op"] as! String == "safari_did_connect" {
            
            os_log(.default, "TabFSmsg sdc")
            TabFSServiceManager.shared.connect()
//
//            let response = NSExtensionItem()
//            response.userInfo = [ "message": [ "aResponse to": "moop" ] ]
//            context.completeRequest(returningItems: [response], completionHandler: nil)
            
            return
        }
        
        TabFSServiceManager.shared.response(message)
//
//        os_log(.default, "Received message from browser.runtime.sendNativeMessage: %@", op as! CVarArg)
        
//        let response = NSExtensionItem()
//        response.userInfo = [ "message": [ "Response to": op ] ]
//
//        // How do I get too the app????
//
//        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
    
}
