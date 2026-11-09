//! Chain sync through upstream `zcash_client_backend::sync::run` over gRPC-web. Silo adds only an in-memory block cache.
use std::collections::BTreeMap;
use std::sync::Mutex;

use async_trait::async_trait;
use zcash_client_backend::data_api::chain::{error, BlockCache, BlockSource};
use zcash_client_backend::data_api::scanning::ScanRange;
use zcash_client_backend::proto::compact_formats::CompactBlock;
use zcash_client_backend::proto::service::compact_tx_streamer_client::CompactTxStreamerClient;
use zcash_protocol::consensus::BlockHeight;

pub type Client = CompactTxStreamerClient<tonic_web_wasm_client::Client>;

pub fn client(url: &str) -> Client {
    CompactTxStreamerClient::new(tonic_web_wasm_client::Client::new(url.to_string()))
}

#[derive(Debug)]
pub struct CacheError(&'static str);
impl std::fmt::Display for CacheError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for CacheError {}

/// Blocks downloaded for the scan range in progress; dropped after each sync.
#[derive(Default)]
pub struct MemBlockCache(Mutex<BTreeMap<BlockHeight, CompactBlock>>);

impl MemBlockCache {
    fn blocks(&self) -> Result<std::sync::MutexGuard<'_, BTreeMap<BlockHeight, CompactBlock>>, CacheError> {
        self.0.lock().map_err(|_| CacheError("block cache poisoned"))
    }
}

impl BlockSource for MemBlockCache {
    type Error = CacheError;
    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), error::Error<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), error::Error<WalletErrT, Self::Error>>,
    {
        let selected: Vec<CompactBlock> = {
            let blocks = self.blocks().map_err(error::Error::BlockSource)?;
            blocks
                .range(from_height.unwrap_or(BlockHeight::from_u32(0))..)
                .take(limit.unwrap_or(usize::MAX))
                .map(|(_, block)| block.clone())
                .collect()
        };
        selected.into_iter().try_for_each(&mut with_block)
    }
}

#[async_trait]
impl BlockCache for MemBlockCache {
    fn get_tip_height(&self, range: Option<&ScanRange>) -> Result<Option<BlockHeight>, Self::Error> {
        let blocks = self.blocks()?;
        Ok(match range {
            Some(range) => blocks.range(range.block_range().clone()).next_back().map(|(h, _)| *h),
            None => blocks.keys().next_back().copied(),
        })
    }
    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        Ok(self.blocks()?.range(range.block_range().clone()).map(|(_, b)| b.clone()).collect())
    }
    async fn insert(&self, compact_blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
        let mut blocks = self.blocks()?;
        for block in compact_blocks {
            blocks.insert(block.height(), block);
        }
        Ok(())
    }
    async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
        let mut blocks = self.blocks()?;
        let heights: Vec<_> = blocks.range(range.block_range().clone()).map(|(h, _)| *h).collect();
        for height in heights {
            blocks.remove(&height);
        }
        Ok(())
    }
}
