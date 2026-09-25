import {ComputeBudgetProgram,PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import type {FeeTransactionComposer} from '../../application/charged-trade-quote.js';
import type {SolanaLookupTableResolver} from '../../application/solana-trade-transaction-validator.js';
import {TradingEngineError} from '../../domain/trading.js';
const TOKEN=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export class SolanaFeeTransactionComposer implements FeeTransactionComposer {
 constructor(private readonly lookups:SolanaLookupTableResolver,private readonly usdcMint:string,
   private readonly treasuryToken:string,private readonly payer:string,private readonly decimals=6){}
 async collect(serialized:string,wallet:string,feeUnits:bigint):Promise<string>{
  const tx=VersionedTransaction.deserialize(Buffer.from(serialized,'base64'));
  if(feeUnits<=0n||feeUnits>18446744073709551615n||tx.signatures.some(s=>s.some(b=>b!==0))
    ||tx.message.header.numRequiredSignatures!==2||tx.message.staticAccountKeys[0]?.toBase58()!==this.payer
    ||tx.message.staticAccountKeys[1]?.toBase58()!==wallet)throw invalid();
  const lookups=[...await this.lookups.resolve(tx.message.addressTableLookups.map(l=>l.accountKey.toBase58()))];
  const message=TransactionMessage.decompile(tx.message,{addressLookupTableAccounts:lookups});
  const owner=new PublicKey(wallet),mint=new PublicKey(this.usdcMint),treasury=new PublicKey(this.treasuryToken);
  const source=PublicKey.findProgramAddressSync([owner.toBuffer(),TOKEN.toBuffer(),mint.toBuffer()],ATA)[0];
  if(source.equals(treasury))throw invalid();
  // Keep the provider route/blockhash, only add headroom for the one transfer.
  // No duplicate ComputeBudget instruction; simulation validates the final message.
  const instructions=message.instructions.map(ix=>{
   // The provider was requested with platformFeeBps=0. It must not pre-collect
   // any direct token payment before Tradee appends its one reviewed fee.
   if(ix.programId.equals(TOKEN)||ix.programId.toBase58()==='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')throw invalid();
   if(ix.programId.equals(ComputeBudgetProgram.programId)&&ix.data[0]===2){
     if(ix.data.length!==5)throw invalid();
     return ComputeBudgetProgram.setComputeUnitLimit({units:Math.min(1_400_000,ix.data.readUInt32LE(1)+20_000)});
   }return ix;
  });
  const data=Buffer.alloc(10);data[0]=12;data.writeBigUInt64LE(feeUnits,1);data[9]=this.decimals;
  instructions.push(new TransactionInstruction({programId:TOKEN,keys:[
    {pubkey:source,isSigner:false,isWritable:true},{pubkey:mint,isSigner:false,isWritable:false},
    {pubkey:treasury,isSigner:false,isWritable:true},{pubkey:owner,isSigner:true,isWritable:false}],data}));
  const result=new VersionedTransaction(new TransactionMessage({payerKey:message.payerKey,recentBlockhash:message.recentBlockhash,instructions}).compileToV0Message(lookups));
  if(result.message.header.numRequiredSignatures!==2||result.message.staticAccountKeys[1]?.toBase58()!==wallet)throw invalid();
  const bytes=result.serialize();if(bytes.length>1232)throw invalid();
  return Buffer.from(bytes).toString('base64');
 }
}
function invalid(){return new TradingEngineError('TRADE_TRANSACTION_MISMATCH','The fee collection transaction could not be prepared safely.',true);}
