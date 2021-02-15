//
//  main.m
//  TabFSService
//
//  Created by Omar Rizwan on 2/7/21.
//

import Foundation

ProcessInfo.processInfo.disableAutomaticTermination("ok")

let delegate = TabFSServiceDelegate()
let listener = NSXPCListener.service()
listener.delegate = delegate
listener.resume()
