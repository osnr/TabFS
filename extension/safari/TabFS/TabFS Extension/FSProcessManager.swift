//
//  FSProcessManager.swift
//  TabFS
//
//  Created by Omar Rizwan on 1/31/21.
//

import Foundation

import SafariServices.SFSafariApplication
import os.log

let extensionBundleIdentifier = "com.rsnous.TabFS-Extension"

class FSProcessManager {
    static let shared = FSProcessManager()
    
    // FIXME: should accept XPC connection to extension
    // so it can get replies (??)
    
    var fs: Process!
    var fsInput: FileHandle!
    var fsOutput: FileHandle!
    
    func start() {
        fs = Process()
        fs.executableURL = URL(fileURLWithPath: "/Users/osnr/Code/tabfs/fs/tabfs")
        
        os_log(.default, "url: %{public}@", fs.executableURL as! NSURL)
        
        fs.arguments = []
        
        let inputPipe = Pipe(), outputPipe = Pipe()
        fs.standardInput = inputPipe
        fs.standardOutput = outputPipe
        
        try! fs.run()
        
        fsInput = inputPipe.fileHandleForWriting
        fsOutput = outputPipe.fileHandleForReading
//
//        SFSafariApplication.dispatchMessage(
//            withName: "ToSafari",
//            toExtensionWithIdentifier: extensionBundleIdentifier,
//            userInfo: [:]
//        ) { error in
//            debugPrint("Message attempted. Error info: \(String.init(describing: error))")
//        }
        
        DispatchQueue.global(qos: .background).async {
            while true {
                let req = self.awaitRequest()
                
                SFSafariApplication.dispatchMessage(
                    withName: "ToSafari",
                    toExtensionWithIdentifier: extensionBundleIdentifier,
                    userInfo: req
                ) { error in
                    debugPrint("Message attempted. Error info: \(String.init(describing: error))")
                }
            }
        }
    }
    
    func awaitRequest() -> [String: Any] {
        let length = fsOutput.readData(ofLength: 4).withUnsafeBytes {
            $0.load(as: UInt32.self)
        }
        let data = fsOutput.readData(ofLength: Int(length))
        return try! JSONSerialization.jsonObject(with: data, options: []) as! [String: Any]
    }
    
    func respond(_ resp: [AnyHashable: Any]) {
        try! fsInput.write(JSONSerialization.data(withJSONObject: resp, options: []))
    }
}
